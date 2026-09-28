// Feature 9: Offboarding & Exit Management — types.
//
// UROS_Global_Reasoning_Standard.md: every stored outcome must carry a
// reason_code, reason_description, and evidence. offboarding_steps
// stores the human-readable reason_description in `approval_reason`
// (mandatory whenever status is APPROVED/REJECTED — enforced by a DB
// CHECK constraint) and the machine-readable reason_code + supporting
// evidence inside `evidence`. Every mutation additionally writes a full
// audit_log entry via logAudit(). The agent never finalizes a step —
// APPROVED/REJECTED is only ever set by a human via
// PATCH /api/v1/offboarding/steps/:step_id (Core Principle: HIL).

export type OffboardingCaseStatus = "ACTIVE" | "COMPLETED" | "CANCELLED";

export type OffboardingStepStatus =
  | "PENDING"
  | "IN_PROGRESS"
  | "COMPLETED"
  | "APPROVED"
  | "REJECTED"
  | "OVERDUE";

export interface OffboardingChecklistItem {
  item_code: string;
  title: string;
  category?: string;
  /** Default UROS user assigned this step when a case does not override it. */
  default_assignee_user_id?: string | null;
  /**
   * Offset in days relative to offboarding_cases.exit_date.
   * Negative = must be completed before the exit date (e.g. -3 = 3 days
   * before exit); positive = may be completed after (e.g. +7 = final
   * settlement due a week after exit); 0/omitted = due on the exit date.
   */
  default_due_days_from_exit?: number;
}

export interface OffboardingTemplate {
  template_id: string;
  org_id: string;
  role: string;
  checklist: OffboardingChecklistItem[];
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface OffboardingCase {
  case_id: string;
  org_id: string;
  employee_id: string;
  template_id: string;
  status: OffboardingCaseStatus;
  exit_date: string;
  created_by: string | null;
  created_at: string;
}

export interface OffboardingStep {
  step_id: string;
  case_id: string;
  item_code: string;
  title: string;
  category: string | null;
  assigned_to: string | null;
  status: OffboardingStepStatus;
  due_date: string | null;
  completed_at: string | null;
  approved_by: string | null;
  approval_reason: string | null;
  evidence: Record<string, unknown>;
  created_at: string;
}

/** Per-item assignment/due-date override supplied to POST /offboarding/start. */
export interface OffboardingStepOverride {
  item_code: string;
  assigned_to?: string | null;
  due_date?: string | null;
}

/**
 * Result of expanding a template's checklist for a given exit date —
 * pure, deterministic, DB-free (see offboarding_agent.expandTemplateChecklist).
 * Shape matches the columns offboarding_steps needs, minus generated
 * identifiers/timestamps.
 */
export interface ExpandedOffboardingStep {
  item_code: string;
  title: string;
  category: string | null;
  assigned_to: string | null;
  due_date: string | null;
}

export type OffboardingStepAction = "COMPLETE" | "APPROVE" | "REJECT";
