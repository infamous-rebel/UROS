import { db } from "../../database/client";
import { logAudit } from "../../utils/audit_helper";
import {
  OffboardingChecklistItem,
  OffboardingStepOverride,
  ExpandedOffboardingStep,
  OffboardingStep,
  OffboardingCase,
  OffboardingStepAction,
} from "../../models/offboarding.model";

/**
 * Feature 9: Offboarding & Exit Management.
 *
 * Mirrors onboarding_agent's template -> instantiated-checklist pattern,
 * plus the mandatory human approval step onboarding does not require:
 * every step closure (COMPLETE) must additionally be APPROVED or
 * REJECTED by a human before it counts toward case completion
 * (UROS_Global_Reasoning_Standard.md; Core Principle: Human-in-the-Loop).
 * The agent never sets a step to APPROVED/REJECTED itself.
 */

// -----------------------------------------------------------------------
// Pure functions (unit-tested directly — no DB)
// -----------------------------------------------------------------------

/** Adds `days` (may be negative) to an ISO date string, returning an ISO timestamp at midnight UTC. */
export function addDaysToDate(isoDate: string, days: number): string {
  const base = new Date(`${isoDate}T00:00:00.000Z`);
  if (Number.isNaN(base.getTime())) {
    throw new Error(`Invalid exit_date: ${isoDate}`);
  }
  const result = new Date(base.getTime() + days * 24 * 60 * 60 * 1000);
  return result.toISOString();
}

/**
 * Deterministically expands a template's checklist into concrete steps
 * for a specific case. Pure — no DB, no randomness, no clock reads other
 * than via the caller-supplied `exitDate`. Overrides (per item_code) take
 * precedence over the template's defaults; anything left unresolved
 * (no override, no template default) is `null` (unassigned / no due date),
 * never silently guessed.
 */
export function expandTemplateChecklist(
  checklist: OffboardingChecklistItem[],
  exitDate: string,
  overrides: OffboardingStepOverride[] = []
): ExpandedOffboardingStep[] {
  const overrideByItem = new Map(overrides.map((o) => [o.item_code, o]));

  return checklist.map((item) => {
    const override = overrideByItem.get(item.item_code);

    const assigned_to =
      override && "assigned_to" in override
        ? override.assigned_to ?? null
        : item.default_assignee_user_id ?? null;

    let due_date: string | null;
    if (override && "due_date" in override && override.due_date !== undefined) {
      due_date = override.due_date;
    } else if (item.default_due_days_from_exit !== undefined) {
      due_date = addDaysToDate(exitDate, item.default_due_days_from_exit);
    } else {
      due_date = null;
    }

    return {
      item_code: item.item_code,
      title: item.title,
      category: item.category ?? null,
      assigned_to,
      due_date,
    };
  });
}

/**
 * Determines whether a single step is overdue. Pure — the caller
 * supplies `now` explicitly so this is fully deterministic and testable
 * without mocking the system clock. Only PENDING/IN_PROGRESS steps can
 * become overdue; a step already COMPLETED/APPROVED/REJECTED/OVERDUE is
 * left alone (mirrors task_log_agent.flagOverdueTasks /
 * onboarding_agent.flagOverdueAssignments).
 */
export function isStepOverdue(
  step: { status: string; due_date: string | null },
  now: Date = new Date()
): boolean {
  if (step.due_date === null) return false;
  if (step.status !== "PENDING" && step.status !== "IN_PROGRESS") return false;
  return new Date(step.due_date).getTime() < now.getTime();
}

// -----------------------------------------------------------------------
// Template configuration
// -----------------------------------------------------------------------

function assertUniqueItemCodes(checklist: OffboardingChecklistItem[]): void {
  const seen = new Set<string>();
  for (const item of checklist) {
    if (seen.has(item.item_code)) {
      throw new Error(`Duplicate item_code in checklist: ${item.item_code}`);
    }
    seen.add(item.item_code);
  }
}

/**
 * POST /api/v1/offboarding/configure — creates a new template, or updates
 * an existing one owned by the same org (checklist/role replaced
 * wholesale; template_id is stable so in-flight cases already expanded
 * from a prior checklist version are unaffected — mirrors reference
 * question-set versioning in spirit, but templates are edited in place
 * here since, unlike reference questions, a template's identity — not
 * its exact historical checklist — is what offboarding_cases.template_id
 * points at for traceability).
 */
export async function configureOffboardingTemplate(
  orgId: string,
  role: string,
  checklist: OffboardingChecklistItem[],
  actorUserId: string,
  templateId?: string
): Promise<{ template_id: string; org_id: string; role: string; checklist: OffboardingChecklistItem[]; created_by: string | null; created_at: string; updated_at: string }> {
  assertUniqueItemCodes(checklist);

  if (templateId) {
    const existing = await db.query(`SELECT template_id FROM offboarding_templates WHERE template_id=$1 AND org_id=$2`, [
      templateId,
      orgId,
    ]);
    if (existing.rowCount === 0) {
      throw new Error(`Offboarding template not found: ${templateId}`);
    }
    const updated = await db.query(
      `UPDATE offboarding_templates SET role=$1, checklist=$2, updated_at=now()
       WHERE template_id=$3 AND org_id=$4 RETURNING *`,
      [role, JSON.stringify(checklist), templateId, orgId]
    );
    await logAudit({
      entity_type: "OFFBOARDING_TEMPLATE",
      entity_id: templateId,
      agent_or_user: actorUserId,
      action: "OFFBOARDING_TEMPLATE_UPDATED",
      output_value: { role, item_count: checklist.length },
      reason_code: "OFFBOARDING_TEMPLATE_UPDATED",
      reason_comment: `Offboarding template for role "${role}" updated with ${checklist.length} checklist item(s).`,
    });
    return updated.rows[0];
  }

  const created = await db.query(
    `INSERT INTO offboarding_templates (org_id, role, checklist, created_by)
     VALUES ($1,$2,$3,$4) RETURNING *`,
    [orgId, role, JSON.stringify(checklist), actorUserId]
  );
  await logAudit({
    entity_type: "OFFBOARDING_TEMPLATE",
    entity_id: created.rows[0].template_id,
    agent_or_user: actorUserId,
    action: "OFFBOARDING_TEMPLATE_CREATED",
    output_value: { role, item_count: checklist.length },
    reason_code: "OFFBOARDING_TEMPLATE_CREATED",
    reason_comment: `Offboarding template for role "${role}" created with ${checklist.length} checklist item(s).`,
  });
  return created.rows[0];
}

// -----------------------------------------------------------------------
// Case creation (I/O orchestration around the pure expansion above)
// -----------------------------------------------------------------------

export interface StartOffboardingCaseResult {
  case: OffboardingCase;
  steps: OffboardingStep[];
}

/**
 * POST /api/v1/offboarding/start — creates the case row and expands the
 * template checklist into concrete offboarding_steps in one transaction.
 * Validates org scoping on both the employee and the template before
 * writing anything (same defense applied to onboarding after the
 * Security Hardening Round finding on onboarding_assignments), and
 * rejects starting a second ACTIVE case for an employee who already has
 * one (enforced additionally by the DB partial unique index as the
 * authoritative guard against a race).
 */
export async function startOffboardingCase(
  employeeId: string,
  templateId: string,
  exitDate: string,
  orgId: string,
  actorUserId: string,
  overrides: OffboardingStepOverride[] = []
): Promise<StartOffboardingCaseResult> {
  const employeeRes = await db.query<{ employee_id: string; status: string }>(
    `SELECT employee_id, status FROM employees WHERE employee_id=$1 AND org_id=$2`,
    [employeeId, orgId]
  );
  if (employeeRes.rowCount === 0) {
    throw new Error(`Employee not found: ${employeeId}`);
  }

  const templateRes = await db.query<{ template_id: string; checklist: OffboardingChecklistItem[] }>(
    `SELECT template_id, checklist FROM offboarding_templates WHERE template_id=$1 AND org_id=$2`,
    [templateId, orgId]
  );
  if (templateRes.rowCount === 0) {
    throw new Error(`Offboarding template not found: ${templateId}`);
  }

  const existingActive = await db.query(
    `SELECT case_id FROM offboarding_cases WHERE employee_id=$1 AND status='ACTIVE'`,
    [employeeId]
  );
  if ((existingActive.rowCount ?? 0) > 0) {
    throw new Error(`Employee ${employeeId} already has an active offboarding case`);
  }

  const expanded = expandTemplateChecklist(templateRes.rows[0].checklist, exitDate, overrides);

  const result = await db.withTransaction(async (client) => {
    const caseRes = await client.query(
      `INSERT INTO offboarding_cases (org_id, employee_id, template_id, status, exit_date, created_by)
       VALUES ($1,$2,$3,'ACTIVE',$4,$5) RETURNING *`,
      [orgId, employeeId, templateId, exitDate, actorUserId]
    );
    const offboardingCase = caseRes.rows[0];

    const steps: OffboardingStep[] = [];
    for (const s of expanded) {
      const stepRes = await client.query(
        `INSERT INTO offboarding_steps (case_id, item_code, title, category, assigned_to, due_date)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
        [offboardingCase.case_id, s.item_code, s.title, s.category, s.assigned_to, s.due_date]
      );
      steps.push(stepRes.rows[0]);
    }

    return { case: offboardingCase, steps };
  });

  await logAudit({
    entity_type: "OFFBOARDING_CASE",
    entity_id: result.case.case_id,
    agent_or_user: actorUserId,
    action: "OFFBOARDING_CASE_STARTED",
    input_value: { employee_id: employeeId, template_id: templateId, exit_date: exitDate },
    output_value: { step_count: result.steps.length },
    reason_code: "OFFBOARDING_CASE_STARTED",
    reason_comment: `Offboarding case created for employee ${employeeId} with ${result.steps.length} step(s), anchored to exit date ${exitDate}.`,
  });

  return result;
}

// -----------------------------------------------------------------------
// Step lookups
// -----------------------------------------------------------------------

/** Loads a case and its steps, scoped to org via the case row itself. Returns null if not found/not in this org. */
export async function getOffboardingCaseWithSteps(
  caseId: string,
  orgId: string
): Promise<{ case: OffboardingCase; steps: OffboardingStep[] } | null> {
  const caseRes = await db.query<OffboardingCase>(`SELECT * FROM offboarding_cases WHERE case_id=$1 AND org_id=$2`, [
    caseId,
    orgId,
  ]);
  if (caseRes.rowCount === 0) return null;

  const stepsRes = await db.query<OffboardingStep>(
    `SELECT * FROM offboarding_steps WHERE case_id=$1 ORDER BY created_at ASC`,
    [caseId]
  );
  return { case: caseRes.rows[0], steps: stepsRes.rows };
}

/**
 * Loads a step scoped to org by joining through its case — offboarding_steps
 * has no org_id column of its own (see migration comment). Never trust
 * step_id alone.
 */
async function loadStepScoped(
  stepId: string,
  orgId: string
): Promise<{ step: OffboardingStep; caseRow: OffboardingCase } | null> {
  const res = await db.query(
    `SELECT s.*, c.case_id AS c_case_id, c.org_id AS c_org_id, c.employee_id AS c_employee_id,
            c.template_id AS c_template_id, c.status AS c_status, c.exit_date AS c_exit_date,
            c.created_by AS c_created_by, c.created_at AS c_created_at
     FROM offboarding_steps s
     JOIN offboarding_cases c ON c.case_id = s.case_id
     WHERE s.step_id=$1 AND c.org_id=$2`,
    [stepId, orgId]
  );
  if (res.rowCount === 0) return null;

  const row = res.rows[0];
  const step: OffboardingStep = {
    step_id: row.step_id,
    case_id: row.case_id,
    item_code: row.item_code,
    title: row.title,
    category: row.category,
    assigned_to: row.assigned_to,
    status: row.status,
    due_date: row.due_date,
    completed_at: row.completed_at,
    approved_by: row.approved_by,
    approval_reason: row.approval_reason,
    evidence: row.evidence,
    created_at: row.created_at,
  };
  const caseRow: OffboardingCase = {
    case_id: row.c_case_id,
    org_id: row.c_org_id,
    employee_id: row.c_employee_id,
    template_id: row.c_template_id,
    status: row.c_status,
    exit_date: row.c_exit_date,
    created_by: row.c_created_by,
    created_at: row.c_created_at,
  };
  return { step, caseRow };
}

// -----------------------------------------------------------------------
// Step closure workflow — COMPLETE (self-report) / APPROVE / REJECT (HIL)
// -----------------------------------------------------------------------

const COMPLETABLE_FROM = new Set(["PENDING", "IN_PROGRESS", "OVERDUE", "REJECTED"]);

export class InvalidStepTransitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidStepTransitionError";
  }
}

/**
 * PATCH /api/v1/offboarding/steps/:step_id with action=COMPLETE — the
 * assignee (or HR on their behalf) self-reports the step as done. This
 * is a recommendation only: status becomes COMPLETED, not APPROVED. A
 * human must still call APPROVE (or REJECT) before it counts toward case
 * completion (UROS_Global_Reasoning_Standard.md: agents may suggest, but
 * never finalize).
 */
export async function completeOffboardingStep(
  stepId: string,
  orgId: string,
  actorUserId: string,
  reason: string,
  evidence: Record<string, unknown> = {}
): Promise<OffboardingStep> {
  const loaded = await loadStepScoped(stepId, orgId);
  if (!loaded) throw new Error(`Offboarding step not found: ${stepId}`);
  if (!COMPLETABLE_FROM.has(loaded.step.status)) {
    throw new InvalidStepTransitionError(
      `Step ${stepId} cannot be marked COMPLETE from status ${loaded.step.status}`
    );
  }

  const mergedEvidence = { ...loaded.step.evidence, ...evidence, reason_code: "STEP_COMPLETED_BY_ASSIGNEE" };

  const updated = await db.query<OffboardingStep>(
    `UPDATE offboarding_steps
     SET status='COMPLETED', completed_at=now(), evidence=$1
     WHERE step_id=$2 RETURNING *`,
    [JSON.stringify(mergedEvidence), stepId]
  );

  await logAudit({
    entity_type: "OFFBOARDING_STEP",
    entity_id: stepId,
    agent_or_user: actorUserId,
    action: "OFFBOARDING_STEP_COMPLETED",
    input_value: { previous_status: loaded.step.status },
    output_value: { status: "COMPLETED" },
    reason_code: "STEP_COMPLETED_BY_ASSIGNEE",
    reason_comment: reason,
  });

  return updated.rows[0];
}

/**
 * PATCH /api/v1/offboarding/steps/:step_id with action=APPROVE|REJECT —
 * the ONLY path by which a step closure is ever finalized. Only a
 * COMPLETED step can be approved/rejected (a human cannot rubber-stamp a
 * step nobody has actually done). REJECTED steps can be re-completed
 * (COMPLETABLE_FROM includes REJECTED) so the workflow can loop back
 * around after correction. On APPROVE, checks whether every step in the
 * case is now APPROVED and, if so, deterministically closes the case and
 * marks the employee OFFBOARDED (see checkAndCompleteCase).
 */
export async function reviewOffboardingStep(
  stepId: string,
  orgId: string,
  actorUserId: string,
  decision: "APPROVE" | "REJECT",
  reason: string
): Promise<{ step: OffboardingStep; case_completed: boolean }> {
  if (!reason || reason.trim().length === 0) {
    throw new Error("A reason is mandatory for approving or rejecting an offboarding step");
  }

  const loaded = await loadStepScoped(stepId, orgId);
  if (!loaded) throw new Error(`Offboarding step not found: ${stepId}`);
  if (loaded.step.status !== "COMPLETED") {
    throw new InvalidStepTransitionError(
      `Step ${stepId} must be COMPLETED before it can be ${decision === "APPROVE" ? "approved" : "rejected"} (current status: ${loaded.step.status})`
    );
  }

  const newStatus = decision === "APPROVE" ? "APPROVED" : "REJECTED";
  const reasonCode = decision === "APPROVE" ? "STEP_APPROVED_BY_HUMAN" : "STEP_REJECTED_BY_HUMAN";
  const mergedEvidence = { ...loaded.step.evidence, reason_code: reasonCode };

  const updated = await db.query<OffboardingStep>(
    `UPDATE offboarding_steps
     SET status=$1, approved_by=$2, approval_reason=$3, evidence=$4
     WHERE step_id=$5 RETURNING *`,
    [newStatus, actorUserId, reason, JSON.stringify(mergedEvidence), stepId]
  );

  await logAudit({
    entity_type: "OFFBOARDING_STEP",
    entity_id: stepId,
    agent_or_user: actorUserId,
    action: `OFFBOARDING_STEP_${newStatus}`,
    input_value: { previous_status: "COMPLETED" },
    output_value: { status: newStatus },
    reason_code: reasonCode,
    reason_comment: reason,
  });

  let caseCompleted = false;
  if (decision === "APPROVE") {
    caseCompleted = await checkAndCompleteCase(loaded.caseRow.case_id, orgId, actorUserId);
  }

  return { step: updated.rows[0], case_completed: caseCompleted };
}

/**
 * Deterministic aggregate check: if every step belonging to `caseId` is
 * APPROVED, closes the case (status=COMPLETED) and marks the employee
 * OFFBOARDED. Never partially applies — either every step is APPROVED
 * and both writes happen atomically, or nothing changes. Idempotent:
 * re-running against an already-COMPLETED case is a no-op.
 */
async function checkAndCompleteCase(caseId: string, orgId: string, actorUserId: string): Promise<boolean> {
  const caseRes = await db.query<OffboardingCase>(`SELECT * FROM offboarding_cases WHERE case_id=$1 AND org_id=$2`, [
    caseId,
    orgId,
  ]);
  if (caseRes.rowCount === 0 || caseRes.rows[0].status !== "ACTIVE") return false;

  const stepsRes = await db.query<{ status: string }>(`SELECT status FROM offboarding_steps WHERE case_id=$1`, [
    caseId,
  ]);
  const allApproved = stepsRes.rowCount! > 0 && stepsRes.rows.every((r) => r.status === "APPROVED");
  if (!allApproved) return false;

  const employeeId = caseRes.rows[0].employee_id;

  await db.withTransaction(async (client) => {
    await client.query(`UPDATE offboarding_cases SET status='COMPLETED' WHERE case_id=$1`, [caseId]);
    await client.query(`UPDATE employees SET status='OFFBOARDED', updated_at=now() WHERE employee_id=$1`, [
      employeeId,
    ]);
  });

  await logAudit({
    entity_type: "OFFBOARDING_CASE",
    entity_id: caseId,
    agent_or_user: actorUserId,
    action: "OFFBOARDING_CASE_COMPLETED",
    output_value: { employee_id: employeeId, step_count: stepsRes.rowCount },
    reason_code: "OFFBOARDING_CASE_COMPLETED",
    reason_comment: `All ${stepsRes.rowCount} offboarding step(s) approved; case closed and employee marked OFFBOARDED.`,
  });

  return true;
}

// -----------------------------------------------------------------------
// Overdue flagging and reminders (pre-approved low-risk automation)
// -----------------------------------------------------------------------

/**
 * Flags offboarding steps past their due_date as OVERDUE. Never touches
 * a COMPLETED/APPROVED/REJECTED step and never itself completes or
 * approves anything — mirrors task_log_agent.flagOverdueTasks and
 * onboarding_agent.flagOverdueAssignments exactly.
 */
export async function flagOverdueSteps(orgId: string): Promise<number> {
  const res = await db.query<{ step_id: string; case_id: string; assigned_to: string | null; title: string }>(
    `SELECT s.step_id, s.case_id, s.assigned_to, s.title
     FROM offboarding_steps s
     JOIN offboarding_cases c ON c.case_id = s.case_id
     WHERE c.org_id=$1 AND c.status='ACTIVE'
       AND s.status IN ('PENDING','IN_PROGRESS')
       AND s.due_date IS NOT NULL AND s.due_date < now()`,
    [orgId]
  );

  for (const row of res.rows) {
    await db.query(`UPDATE offboarding_steps SET status='OVERDUE' WHERE step_id=$1`, [row.step_id]);
    await logAudit({
      entity_type: "OFFBOARDING_STEP",
      entity_id: row.step_id,
      agent_or_user: "OffboardingAgent",
      action: "STEP_FLAGGED_OVERDUE",
      output_value: { case_id: row.case_id, assigned_to: row.assigned_to, title: row.title },
      reason_code: "STEP_FLAGGED_OVERDUE",
      reason_comment: `Step "${row.title}" passed its due date without being completed.`,
    });
  }

  return res.rowCount ?? 0;
}

/**
 * Pre-approved low-risk automation: reminder for steps due within 24h.
 * Like task_log_agent.sendDueReminders, offboarding assignees are
 * internal UROS users (assigned_to references users, not candidates),
 * and communication_log is scoped to applicant-facing candidate messages
 * (candidate_id NOT NULL) — so internal reminders are recorded via the
 * immutable audit trail rather than the Communication Hub's candidate
 * channel. This is still a fully logged, auditable reminder — just
 * routed through the same audit-log mechanism every other internal HR
 * reminder in UROS uses (onboarding_agent has no reminder yet; the
 * closest sibling is task_log_agent.sendDueReminders, which this
 * mirrors exactly).
 */
export async function sendStepDueReminders(orgId: string): Promise<number> {
  const res = await db.query<{ step_id: string; case_id: string; assigned_to: string | null; title: string; due_date: string }>(
    `SELECT s.step_id, s.case_id, s.assigned_to, s.title, s.due_date
     FROM offboarding_steps s
     JOIN offboarding_cases c ON c.case_id = s.case_id
     WHERE c.org_id=$1 AND c.status='ACTIVE'
       AND s.status IN ('PENDING','IN_PROGRESS')
       AND s.due_date IS NOT NULL AND s.due_date BETWEEN now() AND now() + interval '24 hours'`,
    [orgId]
  );

  for (const row of res.rows) {
    await logAudit({
      entity_type: "OFFBOARDING_STEP",
      entity_id: row.step_id,
      agent_or_user: "OffboardingAgent",
      action: "DUE_REMINDER_SENT",
      output_value: { case_id: row.case_id, assigned_to: row.assigned_to, title: row.title, due_date: row.due_date },
      reason_code: "STEP_DUE_REMINDER_SENT",
      reason_comment: `Reminder: step "${row.title}" is due within 24 hours.`,
    });
  }

  return res.rowCount ?? 0;
}

export type { OffboardingStepAction };
