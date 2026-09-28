import { Router, Request, Response, NextFunction } from "express";
import { z } from "zod";
import { authenticate } from "../middleware/auth";
import { rbac } from "../middleware/rbac";
import { validate } from "../middleware/validate";
import { db } from "../../database/client";
import { logAudit } from "../../utils/audit_helper";
import { calculateAndStoreScore } from "../../agents/kpi_agent";

const router = Router();

const FormulaTermSchema = z.object({ metric_field: z.string().min(1), weight: z.number().min(0).max(100) });

const CreateDefinitionSchema = z.object({
  role: z.string().min(1),
  name: z.string().min(1),
  formula: z.array(FormulaTermSchema).min(1),
  cycle: z.enum(["MONTHLY", "QUARTERLY", "ANNUAL"]).default("MONTHLY"),
  band_thresholds: z.record(z.number()).optional(),
}).refine((d) => d.formula.reduce((s, t) => s + t.weight, 0) === 100, {
  message: "formula weights must sum to 100",
});

const CalculateBodySchema = z.object({
  kpi_id: z.string().uuid(),
  employee_id: z.string().uuid(),
  period: z.string().min(4),
  input_metrics: z.record(z.number()),
});

const ScoreIdParamSchema = z.object({ id: z.string().uuid() });
const ApproveBodySchema = z.object({
  decision: z.enum(["APPROVE", "OVERRIDE"]),
  approved_score: z.number().min(0).max(100).optional(),
  override_reason: z.string().optional(),
}).refine((d) => d.decision !== "OVERRIDE" || (!!d.approved_score && !!d.override_reason), {
  message: "override_reason and approved_score are required when overriding",
});

/** POST /api/v1/kpi/definitions — Dept Head/Admin define a KPI formula for a role. */
router.post(
  "/definitions", authenticate, rbac("ADMIN", "DEPT_HEAD"), validate({ body: CreateDefinitionSchema }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = req.body as z.infer<typeof CreateDefinitionSchema>;
      const result = await db.query(
        `INSERT INTO kpi_definitions (org_id, role, name, formula, cycle, band_thresholds, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
        [req.user!.org_id, body.role, body.name, JSON.stringify(body.formula), body.cycle,
         body.band_thresholds ? JSON.stringify(body.band_thresholds) : null, req.user!.user_id]
      );
      await logAudit({
        entity_type: "KPI_DEFINITION", entity_id: result.rows[0].kpi_id, agent_or_user: req.user!.user_id,
        action: "KPI_DEFINITION_CREATED", output_value: { role: body.role, name: body.name },
      });
      res.status(201).json({ kpi_definition: result.rows[0] });
    } catch (err) { next(err); }
  }
);

/** GET /api/v1/kpi/definitions */
router.get(
  "/definitions", authenticate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await db.query(`SELECT * FROM kpi_definitions WHERE org_id=$1 AND active=true ORDER BY created_at DESC`, [req.user!.org_id]);
      res.status(200).json({ kpi_definitions: result.rows, count: result.rowCount });
    } catch (err) { next(err); }
  }
);

/** POST /api/v1/kpi/scores/calculate — deterministic calculation; produces status=CALCULATED, awaiting manager approval. */
router.post(
  "/scores/calculate", authenticate, rbac("ADMIN", "DEPT_HEAD", "SYSTEM_AGENT"), validate({ body: CalculateBodySchema }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { kpi_id, employee_id, period, input_metrics } = req.body as z.infer<typeof CalculateBodySchema>;
      const scoreId = await calculateAndStoreScore(kpi_id, employee_id, period, input_metrics, req.user!.org_id, req.user!.user_id);
      const result = await db.query(`SELECT * FROM kpi_scores WHERE score_id=$1`, [scoreId]);
      res.status(201).json({ kpi_score: result.rows[0] });
    } catch (err) { next(err); }
  }
);

/** GET /api/v1/kpi/scores?employee_id=... — Admin/Dept Head only, org-scoped via kpi_definitions.org_id. */
router.get(
  "/scores", authenticate, rbac("ADMIN", "DEPT_HEAD"),
  validate({ query: z.object({ employee_id: z.string().uuid().optional(), status: z.enum(["CALCULATED", "APPROVED", "OVERRIDDEN"]).optional() }) }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { employee_id, status } = req.query as unknown as { employee_id?: string; status?: string };
      // Security Hardening Round: kpi_scores has no org_id column of its
      // own — previously this endpoint had neither an rbac restriction
      // nor any org filter at all, so any authenticated user of any role
      // could list every org's KPI scores. Scoped here via a join to
      // kpi_definitions.org_id.
      const conditions: string[] = ["d.org_id = $1"];
      const params: unknown[] = [req.user!.org_id];
      if (employee_id) { params.push(employee_id); conditions.push(`s.employee_id = $${params.length}`); }
      if (status) { params.push(status); conditions.push(`s.status = $${params.length}`); }
      const result = await db.query(
        `SELECT s.* FROM kpi_scores s JOIN kpi_definitions d ON d.kpi_id = s.kpi_id
         WHERE ${conditions.join(" AND ")} ORDER BY s.calculated_at DESC`,
        params
      );
      res.status(200).json({ kpi_scores: result.rows, count: result.rowCount });
    } catch (err) { next(err); }
  }
);

/** PATCH /api/v1/kpi/scores/:id/approve — manager approves as-calculated, or overrides with a mandatory reason. */
router.patch(
  "/scores/:id/approve", authenticate, rbac("ADMIN", "DEPT_HEAD"),
  validate({ params: ScoreIdParamSchema, body: ApproveBodySchema }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = req.params as unknown as z.infer<typeof ScoreIdParamSchema>;
      const { decision, approved_score, override_reason } = req.body as z.infer<typeof ApproveBodySchema>;

      const existing = await db.query(
        `SELECT s.* FROM kpi_scores s JOIN kpi_definitions d ON d.kpi_id = s.kpi_id
         WHERE s.score_id=$1 AND d.org_id=$2`,
        [id, req.user!.org_id]
      );
      if (existing.rowCount === 0) { res.status(404).json({ error: "KPI score not found" }); return; }

      const finalScore = decision === "OVERRIDE" ? approved_score! : existing.rows[0].calculated_score;
      const updated = await db.query(
        `UPDATE kpi_scores SET status=$1, approved_score=$2, reviewer_id=$3, override_reason=$4, approved_at=now()
         WHERE score_id=$5 RETURNING *`,
        [decision === "OVERRIDE" ? "OVERRIDDEN" : "APPROVED", finalScore, req.user!.user_id, override_reason ?? null, id]
      );
      await logAudit({
        entity_type: "KPI_SCORE", entity_id: id, agent_or_user: req.user!.user_id,
        action: decision === "OVERRIDE" ? "KPI_SCORE_OVERRIDDEN" : "KPI_SCORE_APPROVED",
        reason_comment: override_reason ?? undefined, output_value: { approved_score: finalScore },
      });
      res.status(200).json({ kpi_score: updated.rows[0] });
    } catch (err) { next(err); }
  }
);

export default router;
