import { Router, Request, Response, NextFunction } from "express";
import { z } from "zod";
import { authenticate } from "../middleware/auth";
import { rbac } from "../middleware/rbac";
import { validate } from "../middleware/validate";
import { db } from "../../database/client";
import { logAudit } from "../../utils/audit_helper";
import { identifyGaps } from "../../agents/improvement_advisor_agent";

const router = Router();

const GenerateBodySchema = z.object({ employee_id: z.string().uuid() });
const ListQuerySchema = z.object({
  employee_id: z.string().uuid().optional(),
  status: z.enum(["SUGGESTED", "MANAGER_APPROVED", "HR_ASSIGNED", "COMPLETED", "REJECTED"]).optional(),
});
const IdParamSchema = z.object({ id: z.string().uuid() });
const PatchBodySchema = z.object({
  status: z.enum(["MANAGER_APPROVED", "HR_ASSIGNED", "COMPLETED", "REJECTED"]),
  assigned_to: z.string().uuid().optional(),
}).refine((d) => d.status !== "HR_ASSIGNED" || !!d.assigned_to, {
  message: "assigned_to is required when status is HR_ASSIGNED",
});

/** POST /api/v1/improvements/generate — runs the deterministic gap comparison (KPI + persona) for an employee. Manager approves, HR assigns — advisor never assigns. */
router.post(
  "/generate", authenticate, rbac("ADMIN", "DEPT_HEAD"), validate({ body: GenerateBodySchema }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { employee_id } = req.body as z.infer<typeof GenerateBodySchema>;
      const suggestionIds = await identifyGaps(req.user!.org_id, employee_id, req.user!.user_id);
      res.status(201).json({ employee_id, suggestions_generated: suggestionIds.length, suggestion_ids: suggestionIds });
    } catch (err) { next(err); }
  }
);

/** GET /api/v1/improvements */
router.get(
  "/", authenticate, rbac("ADMIN", "DEPT_HEAD"), validate({ query: ListQuerySchema }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { employee_id, status } = req.query as unknown as z.infer<typeof ListQuerySchema>;
      const conditions: string[] = ["org_id=$1"];
      const params: unknown[] = [req.user!.org_id];
      if (employee_id) { params.push(employee_id); conditions.push(`employee_id = $${params.length}`); }
      if (status) { params.push(status); conditions.push(`status = $${params.length}`); }
      const result = await db.query(`SELECT * FROM improvement_suggestions WHERE ${conditions.join(" AND ")} ORDER BY created_at DESC`, params);
      res.status(200).json({ suggestions: result.rows, count: result.rowCount });
    } catch (err) { next(err); }
  }
);

/** PATCH /api/v1/improvements/:id — Manager approves/rejects; HR assigns the development action. */
router.patch(
  "/:id", authenticate, rbac("ADMIN", "DEPT_HEAD"), validate({ params: IdParamSchema, body: PatchBodySchema }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = req.params as unknown as z.infer<typeof IdParamSchema>;
      const { status, assigned_to } = req.body as z.infer<typeof PatchBodySchema>;

      const existing = await db.query(`SELECT * FROM improvement_suggestions WHERE suggestion_id=$1 AND org_id=$2`, [id, req.user!.org_id]);
      if (existing.rowCount === 0) { res.status(404).json({ error: "Suggestion not found" }); return; }

      const updated = await db.query(
        `UPDATE improvement_suggestions SET status=$1, assigned_to=COALESCE($2, assigned_to), reviewed_by=$3, reviewed_at=now()
         WHERE suggestion_id=$4 RETURNING *`,
        [status, assigned_to ?? null, req.user!.user_id, id]
      );
      await logAudit({
        entity_type: "IMPROVEMENT_SUGGESTION", entity_id: id, agent_or_user: req.user!.user_id,
        action: "SUGGESTION_" + status, output_value: { assigned_to: assigned_to ?? null },
      });
      res.status(200).json({ suggestion: updated.rows[0] });
    } catch (err) { next(err); }
  }
);

export default router;
