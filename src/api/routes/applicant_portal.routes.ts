import { Router, Request, Response, NextFunction } from "express";
import { z } from "zod";
import { authenticate } from "../middleware/auth";
import { rbac } from "../middleware/rbac";
import { validate } from "../middleware/validate";
import { createRateLimiter } from "../middleware/rate_limit";
import { db } from "../../database/client";
import {
  requestApplicantOtp,
  verifyApplicantOtp,
  getApplicantStatusView,
  upsertPortalConfig,
  updateApplicantPreferredLanguage,
  OtpVerificationError,
} from "../../agents/applicant_portal_agent";
import { SUPPORTED_LANGUAGES } from "../../services/i18n/translations";

// This router is intentionally mounted separately from the main
// dashboard API (see server.ts: `/api/v1/portal`), matching Feature 4's
// requirement to be "a new read-only public applicant portal, separate
// from the main dashboard." Every route below either requires no
// authentication (OTP request/verify — a candidate has no account yet)
// or the standard APPLICANT-scoped JWT issued by verifyApplicantOtp,
// enforced by the same `authenticate`/`rbac` middleware every other
// UROS route uses.
const router = Router();

const otpRequestRateLimit = createRateLimiter("applicant_otp_request", 5, 60_000);
const otpVerifyRateLimit = createRateLimiter("applicant_otp_verify", 10, 60_000);
const statusRateLimit = createRateLimiter("applicant_status_view", 60, 60_000);

// ---------------------------------------------------------------------
// Public: OTP request / verify
// ---------------------------------------------------------------------

const OtpRequestBodySchema = z.object({
  candidate_id: z.string().min(1),
  channel: z.enum(["EMAIL", "SMS"]),
});

/**
 * POST /api/v1/portal/otp/request
 * Public. Always responds 200 with { requested: true } regardless of
 * whether candidate_id exists, to avoid leaking which application IDs
 * are valid. See applicant_portal_agent.requestApplicantOtp.
 */
router.post(
  "/otp/request",
  otpRequestRateLimit,
  validate({ body: OtpRequestBodySchema }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { candidate_id, channel } = req.body as z.infer<typeof OtpRequestBodySchema>;
      const result = await requestApplicantOtp(candidate_id, channel);
      res.status(200).json(result);
    } catch (err) {
      next(err);
    }
  }
);

const OtpVerifyBodySchema = z.object({
  candidate_id: z.string().min(1),
  code: z.string().length(6),
});

/**
 * POST /api/v1/portal/otp/verify
 * Public. On success, issues a standard UROS JWT (role=APPLICANT,
 * user_id=candidate_id) — the same token shape/verification path as
 * every other authenticated route in the system.
 */
router.post(
  "/otp/verify",
  otpVerifyRateLimit,
  validate({ body: OtpVerifyBodySchema }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { candidate_id, code } = req.body as z.infer<typeof OtpVerifyBodySchema>;
      const result = await verifyApplicantOtp(candidate_id, code);
      res.status(200).json(result);
    } catch (err) {
      if (err instanceof OtpVerificationError) {
        res.status(401).json({ error: err.message });
        return;
      }
      next(err);
    }
  }
);

// ---------------------------------------------------------------------
// Applicant-authenticated: own status
// ---------------------------------------------------------------------

const StatusQuerySchema = z.object({ lang: z.string().min(2).max(5).optional() });

/**
 * GET /api/v1/portal/status
 * Requires an APPLICANT-scoped JWT (from /otp/verify). Always scoped to
 * the token's own candidate_id — there is no candidate_id parameter, so
 * an applicant can never view anyone else's application by construction.
 */
router.get(
  "/status",
  authenticate,
  rbac("APPLICANT"),
  statusRateLimit,
  validate({ query: StatusQuerySchema }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { lang } = req.query as z.infer<typeof StatusQuerySchema>;
      const view = await getApplicantStatusView(req.user!.user_id, req.user!.org_id, lang);
      res.status(200).json({ status: view });
    } catch (err: any) {
      if (/not found/i.test(err?.message ?? "")) {
        res.status(404).json({ error: "Application not found" });
        return;
      }
      next(err);
    }
  }
);

const PreferencesBodySchema = z.object({
  preferred_language: z.enum(SUPPORTED_LANGUAGES),
});

/**
 * PATCH /api/v1/portal/preferences
 * Feature 5: lets the authenticated applicant set their own
 * candidates.preferred_language, which the Communication Hub uses (ahead
 * of the org default) when selecting which language variant of a
 * template to send them.
 */
router.patch(
  "/preferences",
  authenticate,
  rbac("APPLICANT"),
  statusRateLimit,
  validate({ body: PreferencesBodySchema }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { preferred_language } = req.body as z.infer<typeof PreferencesBodySchema>;
      const result = await updateApplicantPreferredLanguage(req.user!.user_id, req.user!.org_id, preferred_language);
      res.status(200).json({ preferences: result });
    } catch (err: any) {
      if (/not found/i.test(err?.message ?? "")) {
        res.status(404).json({ error: "Application not found" });
        return;
      }
      next(err);
    }
  }
);

// ---------------------------------------------------------------------
// Org admin: portal configuration (visibility, timeline text,
// localization, appeal toggle)
// ---------------------------------------------------------------------

const ConfigBodySchema = z.object({
  visible_reason_codes: z.array(z.string()).nullable().optional(),
  estimated_timeline_text: z.string().min(1).optional(),
  appeal_enabled: z.boolean().optional(),
  localized_messages: z.record(z.object({ estimated_timeline_text: z.string().optional(), next_update_text: z.string().optional() })).optional(),
  default_language: z.string().min(2).max(5).optional(),
});

/** GET /api/v1/portal/admin/config — current org's portal configuration (defaults shown if unset). */
router.get("/admin/config", authenticate, rbac("ADMIN", "DEPT_HEAD", "AUDITOR"), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const result = await db.query(`SELECT * FROM applicant_portal_configs WHERE org_id=$1`, [req.user!.org_id]);
    if (result.rowCount === 0) {
      res.status(200).json({
        config: {
          org_id: req.user!.org_id,
          visible_reason_codes: null,
          estimated_timeline_text: "Updates are typically posted within 2-3 weeks of each stage.",
          appeal_enabled: true,
          localized_messages: {},
          default_language: "en",
          updated_by: null,
          updated_at: null,
        },
      });
      return;
    }
    res.status(200).json({ config: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

/** POST /api/v1/portal/admin/config — upsert the org's portal configuration. Fully audited. */
router.post(
  "/admin/config",
  authenticate,
  rbac("ADMIN", "DEPT_HEAD"),
  validate({ body: ConfigBodySchema }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const input = req.body as z.infer<typeof ConfigBodySchema>;
      const config = await upsertPortalConfig(req.user!.org_id, input, req.user!.user_id);
      res.status(200).json({ config });
    } catch (err) {
      next(err);
    }
  }
);

export default router;
