import { Router, Request, Response, NextFunction } from "express";
import { z } from "zod";
import { authenticate } from "../middleware/auth";
import { rbac } from "../middleware/rbac";
import { validate } from "../middleware/validate";
import { db } from "../../database/client";
import { logAudit } from "../../utils/audit_helper";
import { createAssignmentsFromTemplate } from "../../agents/onboarding_agent";

const router = Router();

const ChecklistItemSchema = z.object({
  item_code: z.string().min(1),
  label: z.string().min(1),
  category: z.string().optional(),
  assigned_role: z.string().optional(),
  default_due_days: z.number().int().positive().optional(),
});

const CreateTemplateSchema = z.object({
  name: z.string().min(1),
  checklist_items: z.array(ChecklistItemSchema).min(1),
});

const CreateEmployeeSchema = z.object({
  candidate_id: z.string().optional(),
  full_name: z.string().min(1),
  email: z.string().email().optional(),
  phone: z.string().optional(),
  department: z.string().optional(),
  position: z.string().optional(),
  manager_user_id: z.string().uuid().optional(),
  start_date: z.string().optional(),
});

const AssignTemplateSchema = z.object({ template_id: z.string().uuid() });
const EmployeeIdParamSchema = z.object({ employeeId: z.string().uuid() });
const AssignmentIdParamSchema = z.object({ id: z.string().uuid() });
const CompleteAssignmentSchema = z.object({ status: z.enum(["IN_PROGRESS", "COMPLETED"]) });

/** POST /api/v1/onboarding/templates — Admin defines a reusable onboarding checklist. */
router.post(
  "/templates", authenticate, rbac("ADMIN"), validate({ body: CreateTemplateSchema }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { name, checklist_items } = req.body as z.infer<typeof CreateTemplateSchema>;
      const result = await db.query(
        `INSERT INTO onboarding_templates (org_id, name, checklist_items, created_by)
         VALUES ($1,$2,$3,$4) RETURNING *`,
        [req.user!.org_id, name, JSON.stringify(checklist_items), req.user!.user_id]
      );
      await logAudit({
        entity_type: "ONBOARDING_TEMPLATE", entity_id: result.rows[0].template_id, agent_or_user: req.user!.user_id,
        action: "TEMPLATE_CREATED", output_value: { name, item_count: checklist_items.length },
      });
      res.status(201).json({ template: result.rows[0] });
    } catch (err) { next(err); }
  }
);

/** GET /api/v1/onboarding/templates */
router.get(
  "/templates", authenticate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await db.query(`SELECT * FROM onboarding_templates WHERE org_id=$1 ORDER BY created_at DESC`, [req.user!.org_id]);
      res.status(200).json({ templates: result.rows, count: result.rowCount });
    } catch (err) { next(err); }
  }
);

/** POST /api/v1/onboarding/employees — creates an employee record (typically after final selection). */
router.post(
  "/employees", authenticate, rbac("ADMIN", "RECRUITER", "SENIOR_RECRUITER"), validate({ body: CreateEmployeeSchema }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = req.body as z.infer<typeof CreateEmployeeSchema>;
      const result = await db.query(
        `INSERT INTO employees (org_id, candidate_id, full_name, email, phone, department, position, manager_user_id, start_date)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
        [req.user!.org_id, body.candidate_id ?? null, body.full_name, body.email ?? null, body.phone ?? null,
         body.department ?? null, body.position ?? null, body.manager_user_id ?? null, body.start_date ?? null]
      );
      await logAudit({
        entity_type: "EMPLOYEE", entity_id: result.rows[0].employee_id, agent_or_user: req.user!.user_id,
        action: "EMPLOYEE_CREATED", output_value: { full_name: body.full_name, department: body.department },
      });
      res.status(201).json({ employee: result.rows[0] });
    } catch (err) { next(err); }
  }
);

/** POST /api/v1/onboarding/employees/:employeeId/assign — instantiate a checklist for this employee. */
router.post(
  "/employees/:employeeId/assign", authenticate, rbac("ADMIN", "RECRUITER", "SENIOR_RECRUITER"),
  validate({ params: EmployeeIdParamSchema, body: AssignTemplateSchema }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { employeeId } = req.params as unknown as z.infer<typeof EmployeeIdParamSchema>;
      const { template_id } = req.body as z.infer<typeof AssignTemplateSchema>;
      const created = await createAssignmentsFromTemplate(employeeId, template_id, req.user!.org_id, req.user!.user_id);
      res.status(201).json({ employee_id: employeeId, template_id, assignments_created: created });
    } catch (err) { next(err); }
  }
);

/** GET /api/v1/onboarding/employees/:employeeId/checklist */
router.get(
  "/employees/:employeeId/checklist", authenticate, validate({ params: EmployeeIdParamSchema }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { employeeId } = req.params as unknown as z.infer<typeof EmployeeIdParamSchema>;
      // Security Hardening Round: onboarding_assignments has no org_id
      // column — previously this had no org check at all, so any
      // authenticated user could view another org's employee's
      // onboarding checklist by guessing a UUID. Scoped via
      // employees.org_id.
      const employeeRes = await db.query(`SELECT employee_id FROM employees WHERE employee_id=$1 AND org_id=$2`, [
        employeeId,
        req.user!.org_id,
      ]);
      if (employeeRes.rowCount === 0) {
        res.status(404).json({ error: "Employee not found" });
        return;
      }
      const result = await db.query(`SELECT * FROM onboarding_assignments WHERE employee_id=$1 ORDER BY created_at ASC`, [employeeId]);
      res.status(200).json({ assignments: result.rows, count: result.rowCount });
    } catch (err) { next(err); }
  }
);

/** PATCH /api/v1/onboarding/assignments/:id — HR/manager confirms an item is in progress or completed. Never auto-completed by the agent. */
router.patch(
  "/assignments/:id", authenticate, rbac("ADMIN", "RECRUITER", "SENIOR_RECRUITER", "DEPT_HEAD"),
  validate({ params: AssignmentIdParamSchema, body: CompleteAssignmentSchema }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = req.params as unknown as z.infer<typeof AssignmentIdParamSchema>;
      const { status } = req.body as z.infer<typeof CompleteAssignmentSchema>;

      // Security Hardening Round: previously updated by assignment_id
      // alone with no org check — cross-tenant write. Verified via a
      // join to employees.org_id before any UPDATE.
      const existing = await db.query(
        `SELECT oa.assignment_id FROM onboarding_assignments oa
         JOIN employees e ON e.employee_id = oa.employee_id
         WHERE oa.assignment_id=$1 AND e.org_id=$2`,
        [id, req.user!.org_id]
      );
      if (existing.rowCount === 0) {
        res.status(404).json({ error: "Onboarding assignment not found" });
        return;
      }

      const updated = status === "COMPLETED"
        ? await db.query(
            `UPDATE onboarding_assignments SET status=$1, completed_at=now(), completed_by=$2 WHERE assignment_id=$3 RETURNING *`,
            [status, req.user!.user_id, id]
          )
        : await db.query(
            `UPDATE onboarding_assignments SET status=$1 WHERE assignment_id=$2 RETURNING *`,
            [status, id]
          );
      await logAudit({
        entity_type: "ONBOARDING_ASSIGNMENT", entity_id: id, agent_or_user: req.user!.user_id,
        action: "ASSIGNMENT_" + status,
      });
      res.status(200).json({ assignment: updated.rows[0] });
    } catch (err) { next(err); }
  }
);

export default router;
