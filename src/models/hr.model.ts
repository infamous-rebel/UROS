// Task Logs
export type TaskStatus = "TODO" | "IN_PROGRESS" | "DONE" | "BLOCKED";
export interface TaskLog {
  task_id: string;
  org_id: string;
  assignee_id: string;
  created_by: string;
  title: string;
  description: string | null;
  priority: "LOW" | "MEDIUM" | "HIGH";
  status: TaskStatus;
  due_date: string | null;
  completed_at: string | null;
  closure_approved_by: string | null;
  created_at: string;
  updated_at: string;
}

// Employees / Onboarding
export type EmployeeStatus = "ONBOARDING" | "ACTIVE" | "OFFBOARDED";
export interface Employee {
  employee_id: string;
  org_id: string;
  candidate_id: string | null;
  full_name: string;
  email: string | null;
  phone: string | null;
  department: string | null;
  position: string | null;
  manager_user_id: string | null;
  start_date: string | null;
  status: EmployeeStatus;
  created_at: string;
  updated_at: string;
}

export interface OnboardingChecklistItem {
  item_code: string;
  label: string;
  category?: string;
  assigned_role?: string;
  default_due_days?: number;
}

export interface OnboardingTemplate {
  template_id: string;
  org_id: string;
  name: string;
  checklist_items: OnboardingChecklistItem[];
  created_by: string | null;
  created_at: string;
}

export type OnboardingAssignmentStatus = "PENDING" | "IN_PROGRESS" | "COMPLETED" | "OVERDUE";
export interface OnboardingAssignment {
  assignment_id: string;
  employee_id: string;
  template_id: string;
  item_code: string;
  label: string;
  assigned_role: string | null;
  status: OnboardingAssignmentStatus;
  due_date: string | null;
  completed_by: string | null;
  completed_at: string | null;
  created_at: string;
}

// KPI
export interface KpiFormulaTerm {
  metric_field: string;
  weight: number;
}
export interface KpiDefinition {
  kpi_id: string;
  org_id: string;
  role: string;
  name: string;
  formula: KpiFormulaTerm[];
  cycle: "MONTHLY" | "QUARTERLY" | "ANNUAL";
  band_thresholds: Record<string, number> | null;
  active: boolean;
  created_by: string | null;
  created_at: string;
}

export type KpiScoreStatus = "CALCULATED" | "APPROVED" | "OVERRIDDEN";
export interface KpiScore {
  score_id: string;
  kpi_id: string;
  employee_id: string;
  period: string;
  input_metrics: Record<string, number>;
  calculated_score: number;
  breakdown: Record<string, number>;
  band: string | null;
  approved_score: number | null;
  reviewer_id: string | null;
  status: KpiScoreStatus;
  override_reason: string | null;
  calculated_at: string;
  approved_at: string | null;
}

// Personas
export interface Persona {
  persona_id: string;
  org_id: string;
  department: string;
  job_family: string;
  name: string;
  version: number;
  active: boolean;
  created_by: string | null;
  created_at: string;
}
export interface PersonaRequirement {
  requirement_id: string;
  persona_id: string;
  field_path: string;
  operator: "EQ" | "NEQ" | "LT" | "LTE" | "GT" | "GTE" | "IN" | "NOT_IN" | "REGEX";
  value: unknown;
  weight: number;
}

// Improvement Advisor
export type SuggestionStatus = "SUGGESTED" | "MANAGER_APPROVED" | "HR_ASSIGNED" | "COMPLETED" | "REJECTED";
export interface ImprovementSuggestion {
  suggestion_id: string;
  org_id: string;
  employee_id: string;
  persona_id: string | null;
  gap_type: string;
  suggestion: string;
  source: "DETERMINISTIC" | "LLM_BYOK";
  status: SuggestionStatus;
  assigned_to: string | null;
  reviewed_by: string | null;
  reviewed_at: string | null;
  created_at: string;
}
