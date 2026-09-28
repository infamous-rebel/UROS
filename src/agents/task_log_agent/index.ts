import { db } from "../../database/client";
import { logAudit } from "../../utils/audit_helper";

/** Flags tasks past their due_date that aren't DONE. Agent never marks a task complete — only humans do. */
export async function flagOverdueTasks(orgId: string): Promise<number> {
  const res = await db.query(
    `SELECT task_id FROM task_logs
     WHERE org_id=$1 AND status IN ('TODO','IN_PROGRESS') AND due_date IS NOT NULL AND due_date < now()`,
    [orgId]
  );
  for (const row of res.rows) {
    await logAudit({
      entity_type: "TASK_LOG",
      entity_id: row.task_id,
      agent_or_user: "TaskLogAgent",
      action: "TASK_FLAGGED_OVERDUE",
    });
  }
  return res.rowCount ?? 0;
}

/**
 * Pre-approved low-risk automation: reminder for tasks due within 24h.
 * `communication_log` is scoped to applicant-facing candidate messages
 * (candidate_id NOT NULL), so internal task reminders are recorded via
 * the audit trail instead — still fully logged, just a different table.
 */
export async function sendDueReminders(orgId: string): Promise<number> {
  const res = await db.query<{ task_id: string; assignee_id: string; title: string; due_date: string }>(
    `SELECT t.task_id, t.assignee_id, t.title, t.due_date
     FROM task_logs t
     WHERE t.org_id=$1 AND t.status IN ('TODO','IN_PROGRESS')
       AND t.due_date IS NOT NULL AND t.due_date BETWEEN now() AND now() + interval '24 hours'`,
    [orgId]
  );

  for (const row of res.rows) {
    await logAudit({
      entity_type: "TASK_LOG",
      entity_id: row.task_id,
      agent_or_user: "TaskLogAgent",
      action: "DUE_REMINDER_SENT",
      output_value: { assignee_id: row.assignee_id, title: row.title, due_date: row.due_date },
    });
  }
  return res.rowCount ?? 0;
}
