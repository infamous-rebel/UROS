import { Router, Request, Response, NextFunction } from "express";
import { z } from "zod";
import { authenticate } from "../middleware/auth";
import { rbac } from "../middleware/rbac";
import { validate } from "../middleware/validate";
import { db } from "../../database/client";
import { logAudit } from "../../utils/audit_helper";
import { SUPPORTED_LANGUAGES } from "../../services/i18n/translations";

const router = Router();

const OrgLanguageBodySchema = z.object({
  default_language: z.enum(SUPPORTED_LANGUAGES),
});

/**
 * PATCH /api/v1/organizations/language
 *
 * Sets the organization-wide fallback UI/communication language
 * (organizations.default_language) used whenever a user or candidate has
 * no personal preference set. ADMIN only; fully audited with the
 * previous value recorded so the audit trail carries the full
 * before/after evidence (Global Reasoning Standard).
 */
router.patch(
  "/language",
  authenticate,
  rbac("ADMIN"),
  validate({ body: OrgLanguageBodySchema }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { default_language } = req.body as z.infer<typeof OrgLanguageBodySchema>;

      const existing = await db.query<{ default_language: string }>(
        `SELECT default_language FROM organizations WHERE org_id=$1`,
        [req.user!.org_id]
      );
      if (existing.rowCount === 0) {
        res.status(404).json({ error: "Organization not found" });
        return;
      }

      await db.query(`UPDATE organizations SET default_language=$1 WHERE org_id=$2`, [
        default_language,
        req.user!.org_id,
      ]);

      await logAudit({
        entity_type: "ORGANIZATION",
        entity_id: req.user!.org_id,
        agent_or_user: req.user!.user_id,
        action: "ORG_DEFAULT_LANGUAGE_UPDATED",
        input_value: { previous_default_language: existing.rows[0].default_language },
        output_value: { default_language },
      });

      res.status(200).json({ org_id: req.user!.org_id, default_language });
    } catch (err) {
      next(err);
    }
  }
);

export default router;
