import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { authedRequest, API_V1, getToken } from "./client";

const enabled = () => !!getToken();

// --- Appeals ---
export function useAppeals(status?: string) {
  return useQuery({
    queryKey: ["appeals", status],
    queryFn: () => authedRequest<{ appeals: any[]; count: number }>(`${API_V1}/appeals${status ? `?status=${status}` : ""}`),
    refetchInterval: 10_000,
    enabled: enabled(),
  });
}
export function useResolveAppeal() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, status, resolution }: { id: string; status: string; resolution: string }) =>
      authedRequest(`${API_V1}/appeals/${id}`, { method: "PATCH", body: JSON.stringify({ status, resolution }) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["appeals"] }),
  });
}

// --- Task Logs ---
export function useTaskLogs(status?: string) {
  return useQuery({
    queryKey: ["task-logs", status],
    queryFn: () => authedRequest<{ tasks: any[]; count: number }>(`${API_V1}/task-logs${status ? `?status=${status}` : ""}`),
    refetchInterval: 10_000,
    enabled: enabled(),
  });
}
export function useUpdateTaskStatus() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, status }: { id: string; status: string }) =>
      authedRequest(`${API_V1}/task-logs/${id}`, { method: "PATCH", body: JSON.stringify({ status }) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["task-logs"] }),
  });
}
export function useApproveTaskClosure() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => authedRequest(`${API_V1}/task-logs/${id}/approve-closure`, { method: "POST" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["task-logs"] }),
  });
}

// --- Onboarding ---
export function useOnboardingTemplates() {
  return useQuery({
    queryKey: ["onboarding-templates"],
    queryFn: () => authedRequest<{ templates: any[]; count: number }>(`${API_V1}/onboarding/templates`),
    enabled: enabled(),
  });
}
export function useEmployeeChecklist(employeeId: string | null) {
  return useQuery({
    queryKey: ["onboarding-checklist", employeeId],
    queryFn: () => authedRequest<{ assignments: any[]; count: number }>(`${API_V1}/onboarding/employees/${employeeId}/checklist`),
    enabled: enabled() && !!employeeId,
  });
}
export function useUpdateAssignment() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, status }: { id: string; status: string }) =>
      authedRequest(`${API_V1}/onboarding/assignments/${id}`, { method: "PATCH", body: JSON.stringify({ status }) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["onboarding-checklist"] }),
  });
}

// --- KPI ---
export function useKpiScores(employeeId?: string) {
  return useQuery({
    queryKey: ["kpi-scores", employeeId],
    queryFn: () => authedRequest<{ kpi_scores: any[]; count: number }>(`${API_V1}/kpi/scores${employeeId ? `?employee_id=${employeeId}` : ""}`),
    refetchInterval: 15_000,
    enabled: enabled(),
  });
}
export function useApproveKpiScore() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, decision, approved_score, override_reason }: { id: string; decision: "APPROVE" | "OVERRIDE"; approved_score?: number; override_reason?: string }) =>
      authedRequest(`${API_V1}/kpi/scores/${id}/approve`, { method: "PATCH", body: JSON.stringify({ decision, approved_score, override_reason }) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["kpi-scores"] }),
  });
}

// --- Personas ---
export function usePersonas() {
  return useQuery({
    queryKey: ["personas"],
    queryFn: () => authedRequest<{ personas: any[]; count: number }>(`${API_V1}/personas`),
    enabled: enabled(),
  });
}

// --- Improvement Suggestions ---
export function useImprovementSuggestions(status?: string) {
  return useQuery({
    queryKey: ["improvements", status],
    queryFn: () => authedRequest<{ suggestions: any[]; count: number }>(`${API_V1}/improvements${status ? `?status=${status}` : ""}`),
    refetchInterval: 15_000,
    enabled: enabled(),
  });
}
export function useUpdateSuggestion() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, status, assigned_to }: { id: string; status: string; assigned_to?: string }) =>
      authedRequest(`${API_V1}/improvements/${id}`, { method: "PATCH", body: JSON.stringify({ status, assigned_to }) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["improvements"] }),
  });
}
