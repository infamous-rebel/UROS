import { Router, Request, Response, NextFunction } from "express";
import { z } from "zod";
import { authenticate } from "../middleware/auth";
import { rbac } from "../middleware/rbac";
import { validate } from "../middleware/validate";
import { db } from "../../database/client";
import { logAudit } from "../../utils/audit_helper";
import { SUPPORTED_LANGUAGES } from "../../services/i18n/translations";
import {
  AuthError,
  adminRevokeAllSessions,
  inviteUser,
  issueAdminResetLink,
} from "../../services/auth/service";
import { listActiveSessions, revokeSession } from "../../services/auth/sessions";

const router = Router();

const LanguageBodySchema = z.object({
  preferred_language: z.enum(SUPPORTED_LANGUAGES),
});

/**
 * PATCH /api/v1/users/me/language
 *
 * Self-service dashboard language override for staff users
 * (users.preferred_language). Restricted to staff roles: an APPLICANT's
 * JWT has `user_id` set to a candidate_id, which does not exist in the
 * `users` table at all — that surface's equivalent preference is
 * `candidates.preferred_language`, updated instead via
 * `PATCH /api/v1/portal/preferences` on the separate Applicant Portal
 * router (see applicant_portal.routes.ts).
 */
router.patch(
  "/me/language",
  authenticate,
  rbac("ADMIN", "RECRUITER", "SENIOR_RECRUITER", "AUDITOR", "DEPT_HEAD", "SYSTEM_AGENT"),
  validate({ body: LanguageBodySchema }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { preferred_language } = req.body as z.infer<typeof LanguageBodySchema>;

      const result = await db.query<{ user_id: string; preferred_language: string | null }>(
        `UPDATE users SET preferred_language=$1 WHERE user_id=$2
         RETURNING user_id, preferred_language`,
        [preferred_language, req.user!.user_id]
      );

      if (result.rowCount === 0) {
        res.status(404).json({ error: "User not found" });
        return;
      }

      await logAudit({
        entity_type: "USER",
        entity_id: req.user!.user_id,
        agent_or_user: req.user!.user_id,
        action: "USER_LANGUAGE_PREFERENCE_UPDATED",
        output_value: { preferred_language },
      });

      res.status(200).json({ user: result.rows[0] });
    } catch (err) {
      next(err);
    }
  }
);

// ─── Quest 05 Part 1: sessions, invite, in-person handoff ───────────

const InviteSchema = z.object({
  email: z.string().email(),
  full_name: z.string().min(1),
  role: z.enum(["ADMIN", "RECRUITER", "SENIOR_RECRUITER", "AUDITOR", "DEPT_HEAD"]),
  phone: z.string().min(6).optional(),
  dept_scope: z.string().optional(),
});

/**
 * POST /api/v1/users/invite — admin creates a staff user. The person sets
 * their own password through a reset link (SMS-first, email fallback);
 * no temp passwords exist (Decision Lock 1). The response includes the
 * raw link exactly once so an admin can hand it over in person if
 * delivery fails.
 */
router.post(
  "/invite",
  authenticate,
  rbac("ADMIN"),
  validate({ body: InviteSchema }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const input = req.body as z.infer<typeof InviteSchema>;
      const result = await inviteUser(
        { user_id: req.user!.user_id, org_id: req.user!.org_id },
        input,
        req.ip ?? null,
        req.headers["user-agent"] ?? null
      );
      res.status(201).json({ user: result.user, reset_link: result.link, delivered_via: result.delivered_via });
    } catch (err) {
      if (err instanceof AuthError) {
        res.status(err.httpStatus).json({ error: err.message, error_code: err.code });
        return;
      }
      next(err);
    }
  }
);

/**
 * POST /api/v1/users/:userId/password-reset-link — in-person handoff
 * (Decision Lock 1). Generates a reset link and returns the raw string
 * exactly once for display as a QR code / copyable string; only its hash
 * is stored.
 */
router.post(
  "/:userId/password-reset-link",
  authenticate,
  rbac("ADMIN"),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await issueAdminResetLink(
        { user_id: req.user!.user_id, org_id: req.user!.org_id },
        req.params.userId
      );
      res.status(200).json({ reset_link: result.link, expires_in_minutes: result.expires_in_minutes });
    } catch (err) {
      if (err instanceof AuthError) {
        res.status(err.httpStatus).json({ error: err.message, error_code: err.code });
        return;
      }
      next(err);
    }
  }
);

/** GET /api/v1/users/me/sessions — the current user's active sessions. */
router.get("/me/sessions", authenticate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const sessions = await listActiveSessions(req.user!.user_id);
    res.status(200).json({
      sessions: sessions.map((s) => ({
        session_id: s.session_id,
        current: s.session_id === req.user!.session_id,
        created_at: s.created_at,
        last_used_at: s.last_used_at,
        absolute_expires_at: s.absolute_expires_at,
        ip: s.ip,
        user_agent: s.user_agent,
      })),
    });
  } catch (err) {
    next(err);
  }
});

/** DELETE /api/v1/users/me/sessions/:sessionId — revoke one of your own sessions. */
router.delete("/me/sessions/:sessionId", authenticate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const target = req.params.sessionId;
    const owned = await db.query(`SELECT 1 FROM user_sessions WHERE session_id=$1 AND user_id=$2`, [target, req.user!.user_id]);
    if (owned.rowCount === 0) {
      res.status(404).json({ error: "Session not found.", error_code: "SESSION_NOT_FOUND" });
      return;
    }
    await revokeSession(target, req.user!.user_id, "USER_REVOKED_OWN");
    await logAudit({
      org_id: req.user!.org_id,
      entity_type: "USER",
      entity_id: req.user!.user_id,
      agent_or_user: req.user!.user_id,
      action: "SESSION_REVOKED",
      reason_code: "SELF_REVOKED",
      reason_comment: "User revoked their own session from the session manager.",
      output_value: { session_id: target },
    });
    res.status(200).json({ ok: true });
  } catch (err) {
    next(err);
  }
});

/** DELETE /api/v1/users/:userId/sessions — admin revokes all sessions for a user. */
router.delete(
  "/:userId/sessions",
  authenticate,
  rbac("ADMIN"),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const revoked = await adminRevokeAllSessions(
        { user_id: req.user!.user_id, org_id: req.user!.org_id },
        req.params.userId
      );
      res.status(200).json({ ok: true, revoked_sessions: revoked });
    } catch (err) {
      if (err instanceof AuthError) {
        res.status(err.httpStatus).json({ error: err.message, error_code: err.code });
        return;
      }
      next(err);
    }
  }
);

export default router;
