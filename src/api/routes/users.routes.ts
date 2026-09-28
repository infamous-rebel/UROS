import { Router, Request, Response, NextFunction } from "express";
import { z } from "zod";
import { authenticate } from "../middleware/auth";
import { rbac } from "../middleware/rbac";
import { validate } from "../middleware/validate";
import { db } from "../../database/client";
import { logAudit } from "../../utils/audit_helper";
import { SUPPORTED_LANGUAGES } from "../../services/i18n/translations";

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

export default router;
