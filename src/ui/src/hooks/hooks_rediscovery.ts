import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { authedRequest, API_V1, getToken } from "../api/client";

const enabled = () => !!getToken();

export type RediscoveryConsentStatus = "OPTED_IN" | "OPTED_OUT" | "NO_RECORD";
export type RediscoverySuggestionStatus = "PENDING_REVIEW" | "APPROVED" | "REJECTED";
export type RediscoveryOutreachChannel = "SMS" | "EMAIL" | "WHATSAPP";

export interface RediscoveryConsent {
  consent_id: string;
  candidate_id: string;
  org_id: string;
  opted_in: boolean;
  opted_in_at: string | null;
  opted_out_at: string | null;
  updated_at: string;
}

export interface RediscoveryEvidence {
  fit_score: number;
  breakdown: Record<string, number>;
  matched: string[];
  unmatched: string[];
  persona_id: string;
  target_circular_id: string;
  target_position: string | null;
  previous_status: string;
  previous_job_circular_id: string | null;
  previous_position_applied: string | null;
  consent_status: RediscoveryConsentStatus;
  exclusion_checks: Record<string, unknown>;
}

export interface RediscoverySuggestion {
  suggestion_id: string;
  org_id: string;
  candidate_id: string;
  target_circular_id: string;
  target_position: string | null;
  fit_score: number;
  reason_code: string;
  reason_description: string;
  evidence: RediscoveryEvidence;
  status: RediscoverySuggestionStatus;
  created_at: string;
  reviewed_by: string | null;
  reviewed_at: string | null;
  review_reason: string | null;
}

export interface RediscoveryOutreach {
  outreach_id: string;
  suggestion_id: string;
  candidate_id: string;
  target_circular_id: string;
  channel: RediscoveryOutreachChannel;
  template_code: string;
  status: "SENT" | "FAILED";
  sent_at: string;
  response_status: "PENDING" | "INTERESTED" | "NOT_INTERESTED" | "NO_RESPONSE";
  responded_at: string | null;
}

export interface RediscoveryRunResult {
  target_circular_id: string;
  persona_id: string;
  candidates_considered: number;
  candidates_excluded_recent: number;
  candidates_excluded_fraud: number;
  candidates_excluded_consent: number;
  candidates_excluded_already_suggested: number;
  candidates_below_threshold: number;
  suggestions_created: RediscoverySuggestion[];
}

/** GET /rediscovery/consent/:candidate_id — staff-only lookup. */
export function useRediscoveryConsent(candidateId: string | null) {
  return useQuery({
    queryKey: ["rediscovery-consent", candidateId],
    queryFn: () =>
      authedRequest<{ consent: RediscoveryConsent | null; status: RediscoveryConsentStatus }>(
        `${API_V1}/rediscovery/consent/${encodeURIComponent(candidateId as string)}`
      ),
    enabled: enabled() && !!candidateId,
  });
}

/** POST /rediscovery/consent — staff recording consent on a candidate's behalf. */
export function useSetRediscoveryConsent() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { candidate_id: string; opted_in: boolean }) =>
      authedRequest<{ consent: RediscoveryConsent }>(`${API_V1}/rediscovery/consent`, {
        method: "POST",
        body: JSON.stringify(body),
      }),
    onSuccess: (_data, variables) => qc.invalidateQueries({ queryKey: ["rediscovery-consent", variables.candidate_id] }),
  });
}

export interface RunRediscoveryParams {
  target_circular_id: string;
  target_position?: string | null;
  persona_id: string;
  min_fit_score?: number;
  min_days_since_decision?: number;
  require_opt_in?: boolean;
  max_candidates?: number;
}

/** POST /rediscovery/run — ADMIN/SENIOR_RECRUITER only. Only ever writes PENDING_REVIEW suggestions. */
export function useRunRediscoveryMatch() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: RunRediscoveryParams) =>
      authedRequest<RediscoveryRunResult>(`${API_V1}/rediscovery/run`, {
        method: "POST",
        body: JSON.stringify(body),
      }),
    onSuccess: (_data, variables) =>
      qc.invalidateQueries({ queryKey: ["rediscovery-suggestions", variables.target_circular_id] }),
  });
}

/** GET /rediscovery/suggestions — org-scoped, optionally filtered by circular/status. */
export function useRediscoverySuggestions(filters: { target_circular_id?: string; status?: RediscoverySuggestionStatus }) {
  const params = new URLSearchParams();
  if (filters.target_circular_id) params.set("target_circular_id", filters.target_circular_id);
  if (filters.status) params.set("status", filters.status);
  const qs = params.toString();
  return useQuery({
    queryKey: ["rediscovery-suggestions", filters.target_circular_id ?? null, filters.status ?? null],
    queryFn: () =>
      authedRequest<{ suggestions: RediscoverySuggestion[]; count: number }>(
        `${API_V1}/rediscovery/suggestions${qs ? `?${qs}` : ""}`
      ),
    enabled: enabled(),
  });
}

/** PATCH /rediscovery/suggestions/:suggestion_id — the only path by which a suggestion is ever finalized; reason is mandatory. */
export function useReviewRediscoverySuggestion() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ suggestionId, action, reason }: { suggestionId: string; action: "APPROVE" | "REJECT"; reason: string }) =>
      authedRequest<{ suggestion: RediscoverySuggestion }>(`${API_V1}/rediscovery/suggestions/${suggestionId}`, {
        method: "PATCH",
        body: JSON.stringify({ action, reason }),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["rediscovery-suggestions"] });
    },
  });
}

/** POST /rediscovery/outreach — sends via the Communication Hub, only for already-APPROVED suggestions. Human-triggered only. */
export function useSendRediscoveryOutreach() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { suggestion_ids: string[]; channel: RediscoveryOutreachChannel; template_code: string }) =>
      authedRequest<{ sent: RediscoveryOutreach[]; skipped: { suggestion_id: string; reason: string }[] }>(
        `${API_V1}/rediscovery/outreach`,
        { method: "POST", body: JSON.stringify(body) }
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["rediscovery-suggestions"] });
      qc.invalidateQueries({ queryKey: ["rediscovery-outreach"] });
    },
  });
}

/** GET /rediscovery/outreach — additive beyond the literal spec: sent-outreach history for the UI. */
export function useRediscoveryOutreachHistory(filters: { target_circular_id?: string } = {}) {
  const params = new URLSearchParams();
  if (filters.target_circular_id) params.set("target_circular_id", filters.target_circular_id);
  const qs = params.toString();
  return useQuery({
    queryKey: ["rediscovery-outreach", filters.target_circular_id ?? null],
    queryFn: () =>
      authedRequest<{ outreach: RediscoveryOutreach[]; count: number }>(`${API_V1}/rediscovery/outreach${qs ? `?${qs}` : ""}`),
    enabled: enabled(),
  });
}
