import { Router, Request, Response, NextFunction } from "express";
import { z } from "zod";
import { authenticate } from "../middleware/auth";
import { rbac } from "../middleware/rbac";
import { validate } from "../middleware/validate";
import { db } from "../../database/client";
import { logAudit } from "../../utils/audit_helper";
import { checkRuleConflicts } from "../../rules/engine/conflict_checker";
import { Rule } from "../../models/rule.model";

const router = Router();

const ListQuerySchema = z.object({
  rule_pack_id: z.string().uuid().optional(),
  rule_pack_version_id: z.string().uuid().optional(),
  rule_type: z
    .enum(["ELIGIBILITY", "QUOTA", "SCORING", "KNOCKOUT", "WORKFLOW", "COMMUNICATION", "VERIFICATION"])
    .optional(),
});

const CreateRuleBodySchema = z.object({
  rule_pack_version_id: z.string().uuid(),
  rule_code: z.string().min(1),
  rule_type: z.enum(["ELIGIBILITY", "QUOTA", "SCORING", "KNOCKOUT", "WORKFLOW", "COMMUNICATION", "VERIFICATION"]),
  field_path: z.string().min(1),
  operator: z.enum(["EQ", "NEQ", "LT", "LTE", "GT", "GTE", "IN", "NOT_IN", "REGEX"]),
  threshold_type: z.enum(["exact", "numeric_band"]).default("exact"),
  threshold_value: z.unknown(),
  review_margin: z.number().nullable().optional(),
  min_confidence_threshold: z.number().min(0).max(1).default(0.85),
  fail_reason_code: z.string().min(1),
  is_knockout: z.boolean().default(false),
  weight: z.number().nullable().optional(),
});

const UpdateRuleBodySchema = CreateRuleBodySchema.partial().extend({
  active: z.boolean().optional(),
  change_summary: z.string().min(1, "change_summary is required for rule edits"),
});

const IdParamSchema = z.object({ id: z.string().uuid() });

/**
 * GET /api/v1/rules
 * List rule packs / rules, filterable by pack, version, or type.
 */
router.get(
  "/",
  authenticate,
  rbac("ADMIN", "SENIOR_RECRUITER", "AUDITOR"),
  validate({ query: ListQuerySchema }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { rule_pack_id, rule_pack_version_id, rule_type } = req.query as unknown as z.infer<typeof ListQuerySchema>;

      // Security Hardening Round: previously had no org filter at all —
      // any ADMIN/SENIOR_RECRUITER/AUDITOR could list every org's rules.
      // rules has no org_id column; scoped via rules -> rule_pack_versions
      // -> rule_packs.org_id.
      const conditions: string[] = ["rp.org_id = $1"];
      const params: unknown[] = [req.user!.org_id];

      if (rule_pack_version_id) {
        params.push(rule_pack_version_id);
        conditions.push(`r.rule_pack_version_id = $${params.length}`);
      }
      if (rule_type) {
        params.push(rule_type);
        conditions.push(`r.rule_type = $${params.length}`);
      }
      if (rule_pack_id) {
        params.push(rule_pack_id);
        conditions.push(`rpv.rule_pack_id = $${params.length}`);
      }

      const result = await db.query(
        `SELECT r.*, rpv.rule_pack_id, rpv.version_number
         FROM rules r
         JOIN rule_pack_versions rpv ON rpv.version_id = r.rule_pack_version_id
         JOIN rule_packs rp ON rp.rule_pack_id = rpv.rule_pack_id
         WHERE ${conditions.join(" AND ")}
         ORDER BY r.created_at DESC`,
        params
      );

      res.status(200).json({ rules: result.rows, count: result.rowCount });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * POST /api/v1/rules
 * Create a new rule within an existing rule_pack_version. Runs the
 * conflict checker against sibling active rules before insert.
 */
router.post(
  "/",
  authenticate,
  rbac("ADMIN"),
  validate({ body: CreateRuleBodySchema }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = req.body as z.infer<typeof CreateRuleBodySchema>;

      // Security Hardening Round: previously no org check at all — an
      // ADMIN could create a rule under another org's rule_pack_version_id.
      const versionOwnership = await db.query(
        `SELECT 1 FROM rule_pack_versions v JOIN rule_packs rp ON rp.rule_pack_id = v.rule_pack_id
         WHERE v.version_id=$1 AND rp.org_id=$2`,
        [body.rule_pack_version_id, req.user!.org_id]
      );
      if (versionOwnership.rowCount === 0) {
        res.status(404).json({ error: "Rule pack version not found" });
        return;
      }

      const siblingsRes = await db.query<Rule>(
        `SELECT * FROM rules WHERE rule_pack_version_id=$1 AND active=true`,
        [body.rule_pack_version_id]
      );

      const candidateRule: Rule = {
        rule_id: "PENDING",
        created_at: new Date().toISOString(),
        active: true,
        ...body,
        review_margin: body.review_margin ?? null,
        weight: body.weight ?? null,
      } as Rule;

      const conflicts = checkRuleConflicts([...siblingsRes.rows, candidateRule]);
      if (conflicts.length > 0) {
        res.status(409).json({ error: "Rule conflicts detected", conflicts });
        return;
      }

      const result = await db.query(
        `INSERT INTO rules
          (rule_pack_version_id, rule_code, rule_type, field_path, operator,
           threshold_type, threshold_value, review_margin, min_confidence_threshold,
           fail_reason_code, is_knockout, weight)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
         RETURNING *`,
        [
          body.rule_pack_version_id, body.rule_code, body.rule_type, body.field_path, body.operator,
          body.threshold_type, JSON.stringify(body.threshold_value), body.review_margin ?? null,
          body.min_confidence_threshold, body.fail_reason_code, body.is_knockout, body.weight ?? null,
        ]
      );

      await logAudit({
        org_id: req.user!.org_id,
        entity_type: "RULE",
        entity_id: result.rows[0].rule_id,
        agent_or_user: req.user!.user_id,
        action: "RULE_CREATED",
        output_value: result.rows[0],
      });

      res.status(201).json({ rule: result.rows[0] });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * PATCH /api/v1/rules/:id
 * Update a rule. Requires change_summary. Re-runs conflict check.
 */
router.patch(
  "/:id",
  authenticate,
  rbac("ADMIN", "SENIOR_RECRUITER"),
  validate({ params: IdParamSchema, body: UpdateRuleBodySchema }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = req.params as unknown as z.infer<typeof IdParamSchema>;
      const { change_summary, ...fields } = req.body as z.infer<typeof UpdateRuleBodySchema>;

      const existingRes = await db.query<Rule>(
        `SELECT r.* FROM rules r
         JOIN rule_pack_versions v ON v.version_id = r.rule_pack_version_id
         JOIN rule_packs rp ON rp.rule_pack_id = v.rule_pack_id
         WHERE r.rule_id=$1 AND rp.org_id=$2`,
        [id, req.user!.org_id]
      );
      if (existingRes.rowCount === 0) {
        res.status(404).json({ error: "Rule not found" });
        return;
      }
      const existing = existingRes.rows[0];
      const merged: Rule = { ...existing, ...fields } as Rule;

      const siblingsRes = await db.query<Rule>(
        `SELECT * FROM rules WHERE rule_pack_version_id=$1 AND active=true AND rule_id != $2`,
        [existing.rule_pack_version_id, id]
      );
      const conflicts = checkRuleConflicts([...siblingsRes.rows, merged]);
      if (conflicts.length > 0) {
        res.status(409).json({ error: "Rule conflicts detected", conflicts });
        return;
      }

      const setClauses: string[] = [];
      const params: unknown[] = [];
      for (const [key, value] of Object.entries(fields)) {
        params.push(key === "threshold_value" ? JSON.stringify(value) : value);
        setClauses.push(`${key} = $${params.length}`);
      }
      params.push(id);

      const updated = await db.query(
        `UPDATE rules SET ${setClauses.join(", ")} WHERE rule_id=$${params.length} RETURNING *`,
        params
      );

      await logAudit({
        org_id: req.user!.org_id,
        entity_type: "RULE",
        entity_id: id,
        agent_or_user: req.user!.user_id,
        action: "RULE_UPDATED",
        input_value: existing,
        output_value: updated.rows[0],
        reason_comment: change_summary,
      });

      res.status(200).json({ rule: updated.rows[0] });
    } catch (err) {
      next(err);
    }
  }
);

export default router;
