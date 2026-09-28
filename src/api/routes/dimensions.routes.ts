import { Router, Request, Response, NextFunction } from "express";
import { z } from "zod";
import { authenticate } from "../middleware/auth";
import { rbac } from "../middleware/rbac";
import { validate } from "../middleware/validate";
import { db } from "../../database/client";
import { logAudit } from "../../utils/audit_helper";

const router = Router();

const OperatorEnum = z.enum(["EQ", "NEQ", "LT", "LTE", "GT", "GTE", "IN", "NOT_IN", "REGEX"]);

const SubcriterionSchema = z.object({
  field_path: z.string().min(1),
  label: z.string().min(1),
  operator: OperatorEnum,
  threshold_value: z.unknown(),
  weight: z.number().min(0),
  evidence_doc_type: z.string().optional(),
  reason_code: z.string().min(1),
});

const DimensionSchema = z.object({
  dimension_key: z.string().min(1),
  dimension_name: z.string().min(1),
  sequence: z.number().int().min(1),
  weight: z.number().min(0).max(100),
  is_knockout: z.boolean().default(false),
  knockout_threshold: z.number().min(0).max(100).optional(),
  subcriteria: z.array(SubcriterionSchema).min(1),
});

const ConfigureBodySchema = z
  .object({
    persona_id: z.string().uuid().optional(),
    template_id: z.string().uuid().optional(),
    dimensions: z.array(DimensionSchema).min(1).max(20),
  })
  .refine((d) => Math.round(d.dimensions.reduce((s, dim) => s + dim.weight, 0)) === 100, {
    message: "dimension weights must sum to 100",
    path: ["dimensions"],
  });

const ConfigsQuerySchema = z.object({
  persona_id: z.string().uuid().optional(),
  template_id: z.string().uuid().optional(),
});

/**
 * POST /api/v1/dimensions/configure
 * Publishes a new active dimension configuration set (7 dimensions by
 * convention, but any count is accepted as long as weights sum to 100).
 * Deactivates any prior active set for the same (org, persona) scope so
 * exactly one configuration is ever active at a time — mirrors rule pack
 * versioning. Nothing here scores a candidate; it only defines the
 * configurable "brain" a later /evaluations/dimension-run reads.
 */
router.post(
  "/configure",
  authenticate,
  rbac("ADMIN", "DEPT_HEAD"),
  validate({ body: ConfigureBodySchema }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { persona_id, template_id, dimensions } = req.body as z.infer<typeof ConfigureBodySchema>;
      const orgId = req.user!.org_id;

      const created = await db.withTransaction(async (client) => {
        await client.query(
          `UPDATE dimension_configs SET active=false
           WHERE org_id=$1 AND (persona_id IS NOT DISTINCT FROM $2) AND active=true`,
          [orgId, persona_id ?? null]
        );

        const createdConfigs: unknown[] = [];
        for (const dim of dimensions) {
          const configRes = await client.query(
            `INSERT INTO dimension_configs
              (org_id, template_id, persona_id, dimension_key, dimension_name, sequence, weight,
               is_knockout, knockout_threshold, created_by)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
             RETURNING *`,
            [
              orgId,
              template_id ?? null,
              persona_id ?? null,
              dim.dimension_key,
              dim.dimension_name,
              dim.sequence,
              dim.weight,
              dim.is_knockout,
              dim.knockout_threshold ?? null,
              req.user!.user_id,
            ]
          );
          const configRow = configRes.rows[0];

          const subRows = [];
          for (const sub of dim.subcriteria) {
            const subRes = await client.query(
              `INSERT INTO dimension_subcriteria
                (dimension_config_id, field_path, label, operator, threshold_value, weight, evidence_doc_type, reason_code)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
               RETURNING *`,
              [
                configRow.dimension_config_id,
                sub.field_path,
                sub.label,
                sub.operator,
                JSON.stringify(sub.threshold_value),
                sub.weight,
                sub.evidence_doc_type ?? null,
                sub.reason_code,
              ]
            );
            subRows.push(subRes.rows[0]);
          }

          createdConfigs.push({ ...configRow, subcriteria: subRows });
        }
        return createdConfigs;
      });

      await logAudit({
        entity_type: "DIMENSION_CONFIG",
        entity_id: orgId,
        agent_or_user: req.user!.user_id,
        action: "DIMENSION_CONFIG_PUBLISHED",
        output_value: {
          persona_id: persona_id ?? null,
          template_id: template_id ?? null,
          dimension_count: dimensions.length,
        },
      });

      res.status(201).json({ dimension_configs: created, count: created.length });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * GET /api/v1/dimensions/configs
 * Lists the active dimension configuration set (with sub-criteria) for
 * the caller's org, optionally scoped by persona_id, or built-in
 * templates' default dimensions when template_id is given without an
 * org-specific set having been configured yet.
 */
router.get(
  "/configs",
  authenticate,
  validate({ query: ConfigsQuerySchema }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { persona_id, template_id } = req.query as unknown as z.infer<typeof ConfigsQuerySchema>;
      const orgId = req.user!.org_id;

      let configRes;
      if (template_id && !persona_id) {
        // No org set requested for a specific persona: fall back to
        // showing the org's org-wide set if present, else the template's
        // own defaults (org_id IS NULL) so the UI never renders empty.
        configRes = await db.query(
          `SELECT * FROM dimension_configs WHERE org_id=$1 AND persona_id IS NULL AND active=true ORDER BY sequence ASC`,
          [orgId]
        );
        if (configRes.rowCount === 0) {
          configRes = await db.query(
            `SELECT * FROM dimension_configs WHERE org_id IS NULL AND template_id=$1 ORDER BY sequence ASC`,
            [template_id]
          );
        }
      } else {
        configRes = await db.query(
          `SELECT * FROM dimension_configs WHERE org_id=$1 AND active=true AND (persona_id IS NOT DISTINCT FROM $2) ORDER BY sequence ASC`,
          [orgId, persona_id ?? null]
        );
      }

      const configIds = configRes.rows.map((r: any) => r.dimension_config_id);
      const subRes = configIds.length
        ? await db.query(
            `SELECT * FROM dimension_subcriteria WHERE dimension_config_id = ANY($1::uuid[]) AND active=true`,
            [configIds]
          )
        : { rows: [] as any[] };

      const subsByConfig: Record<string, unknown[]> = {};
      for (const sub of subRes.rows) {
        (subsByConfig[sub.dimension_config_id] ??= []).push(sub);
      }

      const dimension_configs = configRes.rows.map((c: any) => ({
        ...c,
        subcriteria: subsByConfig[c.dimension_config_id] ?? [],
      }));

      res.status(200).json({ dimension_configs, count: dimension_configs.length });
    } catch (err) {
      next(err);
    }
  }
);

/** GET /api/v1/dimensions/templates — built-in + org-saved templates. */
router.get(
  "/templates",
  authenticate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await db.query(
        `SELECT * FROM dimension_templates WHERE org_id IS NULL OR org_id=$1 ORDER BY is_builtin DESC, created_at ASC`,
        [req.user!.org_id]
      );
      res.status(200).json({ templates: result.rows, count: result.rowCount });
    } catch (err) {
      next(err);
    }
  }
);

export default router;
