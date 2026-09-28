import { Router, Request, Response, NextFunction } from "express";
import { z } from "zod";
import { authenticate } from "../middleware/auth";
import { rbac } from "../middleware/rbac";
import { validate } from "../middleware/validate";
import { db } from "../../database/client";
import { logAudit } from "../../utils/audit_helper";

const router = Router();

const CreateBodySchema = z.object({
  assignee_id: z.string().uuid(),
  title: z.string().min(1),
  description: z.string().optional(),
  priority: z.enum(["LOW", "MEDIUM", "HIGH"]).default("MEDIUM"),
  due_date: z.string().datetime().optional(),
});

const ListQuerySchema = z.object({
  assignee_id: z.string().uuid().optional(),
  status: z.enum(["TODO", "IN_PROGRESS", "DONE", "BLOCKED"]).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

const IdParamSchema = z.object({ id: z.string().uuid() });

const UpdateStatusSchema = z.object({ status: z.enum(["TODO", "IN_PROGRESS", "DONE", "BLOCKED"]) });

/** POST /api/v1/task-logs — Recruiter/Senior Recruiter/Admin/Dept Head create tasks. */
router.post(
  "/",
  authenticate,
  rbac("RECRUITER", "SENIOR_RECRUITER", "ADMIN", "DEPT_HEAD"),
  validate({ body: CreateBodySchema }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { assignee_id, title, description, priority, due_date } = req.body as z.infer<typeof CreateBodySchema>;
      const result = await db.query(
        `INSERT INTO task_logs (org_id, assignee_id, created_by, title, description, priority, due_date)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
        [req.user!.org_id, assignee_id, req.user!.user_id, title, description ?? null, priority, due_date ?? null]
      );
      await logAudit({
        entity_type: "TASK_LOG", entity_id: result.rows[0].task_id, agent_or_user: req.user!.user_id,
        action: "TASK_CREATED", output_value: { assignee_id, title, priority },
      });
      res.status(201).json({ task: result.rows[0] });
    } catch (err) { next(err); }
  }
);

/** GET /api/v1/task-logs — filterable list; non-privileged roles implicitly scoped to their own assignments. */
router.get(
  "/",
  authenticate,
  validate({ query: ListQuerySchema }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { assignee_id, status, limit, offset } = req.query as unknown as z.infer<typeof ListQuerySchema>;
      const conditions: string[] = ["org_id=$1"];
      const params: unknown[] = [req.user!.org_id];

      const privileged = ["ADMIN", "SENIOR_RECRUITER", "DEPT_HEAD"].includes(req.user!.role);
      if (!privileged) {
        params.push(req.user!.user_id);
        conditions.push(`assignee_id = $${params.length}`);
      } else if (assignee_id) {
        params.push(assignee_id);
        conditions.push(`assignee_id = $${params.length}`);
      }
      if (status) { params.push(status); conditions.push(`status = $${params.length}`); }
      params.push(limit); params.push(offset);

      const result = await db.query(
        `SELECT * FROM task_logs WHERE ${conditions.join(" AND ")}
         ORDER BY due_date ASC NULLS LAST, created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
        params
      );
      res.status(200).json({ tasks: result.rows, count: result.rowCount, limit, offset });
    } catch (err) { next(err); }
  }
);

/** PATCH /api/v1/task-logs/:id — assignee updates their own task status (not final closure — see /approve-closure). */
router.patch(
  "/:id",
  authenticate,
  validate({ params: IdParamSchema, body: UpdateStatusSchema }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = req.params as unknown as z.infer<typeof IdParamSchema>;
      const { status } = req.body as z.infer<typeof UpdateStatusSchema>;

      const existing = await db.query(`SELECT * FROM task_logs WHERE task_id=$1 AND org_id=$2`, [id, req.user!.org_id]);
      if (existing.rowCount === 0) { res.status(404).json({ error: "Task not found" }); return; }

      const privileged = ["ADMIN", "SENIOR_RECRUITER", "DEPT_HEAD"].includes(req.user!.role);
      if (!privileged && existing.rows[0].assignee_id !== req.user!.user_id) {
        res.status(403).json({ error: "You may only update your own tasks" });
        return;
      }

      const updated = await db.query(
        `UPDATE task_logs SET status=$1, updated_at=now() WHERE task_id=$2 RETURNING *`,
        [status, id]
      );
      await logAudit({
        entity_type: "TASK_LOG", entity_id: id, agent_or_user: req.user!.user_id,
        action: "TASK_STATUS_UPDATED", output_value: { status },
      });
      res.status(200).json({ task: updated.rows[0] });
    } catch (err) { next(err); }
  }
);

/** POST /api/v1/task-logs/:id/approve-closure — manager/admin confirms DONE and closes the task. Human-in-loop closure, mandatory. */
router.post(
  "/:id/approve-closure",
  authenticate,
  rbac("SENIOR_RECRUITER", "ADMIN", "DEPT_HEAD"),
  validate({ params: IdParamSchema }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = req.params as unknown as z.infer<typeof IdParamSchema>;
      const existing = await db.query(`SELECT * FROM task_logs WHERE task_id=$1 AND org_id=$2`, [id, req.user!.org_id]);
      if (existing.rowCount === 0) { res.status(404).json({ error: "Task not found" }); return; }
      if (existing.rows[0].status !== "DONE") {
        res.status(409).json({ error: "Task must be marked DONE by the assignee before closure can be approved" });
        return;
      }

      const updated = await db.query(
        `UPDATE task_logs SET completed_at=now(), closure_approved_by=$1, updated_at=now() WHERE task_id=$2 RETURNING *`,
        [req.user!.user_id, id]
      );
      await logAudit({
        entity_type: "TASK_LOG", entity_id: id, agent_or_user: req.user!.user_id, action: "TASK_CLOSURE_APPROVED",
      });
      res.status(200).json({ task: updated.rows[0] });
    } catch (err) { next(err); }
  }
);

export default router;
