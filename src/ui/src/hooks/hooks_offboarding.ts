import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { authedRequest, API_V1, getToken } from "../api/client";

const enabled = () => !!getToken();

export type OffboardingCaseStatus = "ACTIVE" | "COMPLETED" | "CANCELLED";
export type OffboardingStepStatus = "PENDING" | "IN_PROGRESS" | "COMPLETED" | "APPROVED" | "REJECTED" | "OVERDUE";
export type OffboardingStepAction = "COMPLETE" | "APPROVE" | "REJECT";

export interface OffboardingChecklistItem {
  item_code: string;
  title: string;
  category?: string;
  default_assignee_user_id?: string | null;
  default_due_days_from_exit?: number;
}

export interface OffboardingTemplate {
  template_id: string;
  org_id: string;
  role: string;
  checklist: OffboardingChecklistItem[];
  created_at: string;
  updated_at: string;
}

export interface OffboardingCaseRow {
  case_id: string;
  org_id: string;
  employee_id: string;
  template_id: string;
  status: OffboardingCaseStatus;
  exit_date: string;
  created_at: string;
}

export interface OffboardingStepRow {
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

export interface OffboardingCaseDetail {
  case: OffboardingCaseRow;
  steps: OffboardingStepRow[];
  step_count: number;
}

/** Configures (creates or updates) an offboarding template — see POST /offboarding/configure. */
export function useConfigureOffboardingTemplate() {
  return useMutation({
    mutationFn: (body: { template_id?: string; role: string; checklist: OffboardingChecklistItem[] }) =>
      authedRequest<{ template: OffboardingTemplate }>(`${API_V1}/offboarding/configure`, {
        method: "POST",
        body: JSON.stringify(body),
      }),
  });
}

/** Starts an offboarding case for an employee — see POST /offboarding/start. */
export function useStartOffboardingCase() {
  return useMutation({
    mutationFn: (body: { employee_id: string; template_id: string; exit_date: string }) =>
      authedRequest<{ case: OffboardingCaseRow; steps: OffboardingStepRow[] }>(`${API_V1}/offboarding/start`, {
        method: "POST",
        body: JSON.stringify(body),
      }),
  });
}

/** Loads a case with its steps — see GET /offboarding/cases/:case_id. */
export function useOffboardingCase(caseId: string | null) {
  return useQuery({
    queryKey: ["offboarding-case", caseId],
    queryFn: () => authedRequest<OffboardingCaseDetail>(`${API_V1}/offboarding/cases/${caseId}`),
    enabled: enabled() && !!caseId,
  });
}

/** Advances a step: COMPLETE / APPROVE / REJECT, mandatory reason — see PATCH /offboarding/steps/:step_id. */
export function useUpdateOffboardingStep(caseId: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      stepId,
      action,
      reason,
    }: {
      stepId: string;
      action: OffboardingStepAction;
      reason: string;
    }) =>
      authedRequest<{ step: OffboardingStepRow; case_completed?: boolean }>(`${API_V1}/offboarding/steps/${stepId}`, {
        method: "PATCH",
        body: JSON.stringify({ action, reason }),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["offboarding-case", caseId] }),
  });
}
