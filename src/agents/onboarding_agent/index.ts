import { db } from "../../database/client";
import { logAudit } from "../../utils/audit_helper";
import { OnboardingChecklistItem } from "../../models/hr.model";

/**
 * Instantiates onboarding_assignments from a template's checklist for a
 * new employee. Deterministic 1:1 expansion, no inference.
 *
 * Security Hardening Round: orgId is now mandatory and validated against
 * both the template and the employee before any row is created — this
 * previously had no org check at all, so an admin could assign another
 * org's onboarding template to an employee, or target another org's
 * employee_id outright.
 */
export async function createAssignmentsFromTemplate(
  employeeId: string,
  templateId: string,
  orgId: string,
  actorUserId: string
): Promise<number> {
  const templateRes = await db.query(`SELECT * FROM onboarding_templates WHERE template_id=$1 AND org_id=$2`, [templateId, orgId]);
  if (templateRes.rowCount === 0) throw new Error(`Onboarding template not found: ${templateId}`);

  const employeeRes = await db.query(`SELECT employee_id FROM employees WHERE employee_id=$1 AND org_id=$2`, [employeeId, orgId]);
  if (employeeRes.rowCount === 0) throw new Error(`Employee not found: ${employeeId}`);

  const items: OnboardingChecklistItem[] = templateRes.rows[0].checklist_items;
  let created = 0;

  for (const item of items) {
    const dueDate = item.default_due_days != null
      ? `now() + interval '${Number(item.default_due_days)} days'`
      : "NULL";

    await db.query(
      `INSERT INTO onboarding_assignments (employee_id, template_id, item_code, label, assigned_role, due_date)
       VALUES ($1,$2,$3,$4,$5, ${dueDate})`,
      [employeeId, templateId, item.item_code, item.label, item.assigned_role ?? null]
    );
    created += 1;
  }

  await logAudit({
    entity_type: "EMPLOYEE",
    entity_id: employeeId,
    agent_or_user: actorUserId,
    action: "ONBOARDING_ASSIGNED",
    output_value: { template_id: templateId, items: created },
  });

  return created;
}

/** Flags overdue onboarding items. Never completes an item — HR/manager must confirm. */
export async function flagOverdueAssignments(): Promise<number> {
  const res = await db.query(
    `UPDATE onboarding_assignments
     SET status='OVERDUE'
     WHERE status IN ('PENDING','IN_PROGRESS') AND due_date IS NOT NULL AND due_date < now()
     RETURNING assignment_id`
  );
  for (const row of res.rows) {
    await logAudit({
      entity_type: "ONBOARDING_ASSIGNMENT",
      entity_id: row.assignment_id,
      agent_or_user: "OnboardingAgent",
      action: "ASSIGNMENT_FLAGGED_OVERDUE",
    });
  }
  return res.rowCount ?? 0;
}

/** Onboarding completion rate for a single employee — deterministic ratio, used by reporting/UI. */
export async function completionRate(employeeId: string): Promise<{ total: number; completed: number; rate: number }> {
  const res = await db.query<{ status: string }>(
    `SELECT status FROM onboarding_assignments WHERE employee_id=$1`,
    [employeeId]
  );
  const total = res.rowCount ?? 0;
  const completed = res.rows.filter((r) => r.status === "COMPLETED").length;
  return { total, completed, rate: total === 0 ? 0 : Math.round((completed / total) * 100) / 100 };
}
