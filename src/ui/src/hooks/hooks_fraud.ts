import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { authedRequest, API_V1, getToken } from "../api/client";

const enabled = () => !!getToken();

export type FraudCheckType =
  | "AGE_EDUCATION_TIMELINE"
  | "CGPA_DIVISION_CONSISTENCY"
  | "EXPERIENCE_OVERLAP"
  | "DUPLICATE_IDENTITY"
  | "IMPOSSIBLE_DOB_GRADUATION_AGE";

export type FraudSeverity = "LOW" | "MEDIUM" | "HIGH";
export type FraudFlagStatus = "OPEN" | "CONFIRMED" | "FALSE_POSITIVE" | "ESCALATED";

export interface EffectiveFraudCheckView {
  check_type: FraudCheckType;
  check_id: string | null;
  name: string;
  config: Record<string, unknown>;
  is_knockout: boolean;
  active: boolean;
  is_system_default: boolean;
}

export interface FraudFlag {
  flag_id: string;
  org_id: string;
  candidate_id: string;
  check_id: string | null;
  check_type: FraudCheckType;
  severity: FraudSeverity;
  reason_code: string;
  reason_description: string;
  evidence: Record<string, unknown>;
  status: FraudFlagStatus;
  detected_at: string;
  reviewed_by: string | null;
  reviewed_at: string | null;
  resolution: "CONFIRMED" | "FALSE_POSITIVE" | "ESCALATED" | null;
  resolution_reason: string | null;
}

export interface FraudRunResult {
  candidate_id: string;
  checks_run: number;
  flags_created: Array<{ check_type: FraudCheckType; status: "FAIL" | "NEEDS_REVIEW"; reason_code: string; flag_id: string | null }>;
  error?: string;
}

/** Effective check set for the org (configured + system defaults) — see GET /fraud/checks. */
export function useFraudChecks() {
  return useQuery({
    queryKey: ["fraud-checks"],
    queryFn: () =>
      authedRequest<{ checks: EffectiveFraudCheckView[]; count: number; all_check_types: FraudCheckType[] }>(
        `${API_V1}/fraud/checks`
      ),
    enabled: enabled(),
  });
}

/** Create/replace the active configuration for one check type — see POST /fraud/configure. */
export function useConfigureFraudCheck() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { check_type: FraudCheckType; name: string; config?: Record<string, unknown>; active?: boolean; is_knockout?: boolean }) =>
      authedRequest<{ fraud_check: unknown }>(`${API_V1}/fraud/configure`, {
        method: "POST",
        body: JSON.stringify(body),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["fraud-checks"] }),
  });
}

/** Runs fraud detection over an explicit candidate list or a whole circular — see POST /fraud/run. */
export function useRunFraudDetection() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { candidate_ids?: string[]; circular_id?: string }) =>
      authedRequest<{ results: FraudRunResult[]; count: number }>(`${API_V1}/fraud/run`, {
        method: "POST",
        body: JSON.stringify(body),
      }),
    onSuccess: (_data, variables) => {
      for (const id of variables.candidate_ids ?? []) {
        qc.invalidateQueries({ queryKey: ["fraud-flags", id] });
      }
    },
  });
}

/** Full flag history for one candidate, most recent first — see GET /fraud/flags/:candidate_id. */
export function useFraudFlags(candidateId: string | null) {
  return useQuery({
    queryKey: ["fraud-flags", candidateId],
    queryFn: () => authedRequest<{ flags: FraudFlag[]; count: number }>(`${API_V1}/fraud/flags/${candidateId}`),
    enabled: enabled() && !!candidateId,
  });
}

/** Human resolution of a flag: CONFIRMED / FALSE_POSITIVE / ESCALATED, mandatory reason — see PATCH /fraud/flags/:flag_id. */
export function useResolveFraudFlag(candidateId: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      flagId,
      resolution,
      resolution_reason,
    }: {
      flagId: string;
      resolution: "CONFIRMED" | "FALSE_POSITIVE" | "ESCALATED";
      resolution_reason: string;
    }) =>
      authedRequest<{ flag: FraudFlag }>(`${API_V1}/fraud/flags/${flagId}`, {
        method: "PATCH",
        body: JSON.stringify({ resolution, resolution_reason }),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["fraud-flags", candidateId] }),
  });
}
