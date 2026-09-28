import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { authedRequest, API_V1, getToken } from "../api/client";

const enabled = () => !!getToken();

export interface SubcriterionEvidence {
  subcriterion_id: string;
  field_path: string;
  label: string;
  operator: string;
  threshold_value: unknown;
  extracted_value: unknown;
  matched: boolean;
  flagged: boolean;
  flag_reason: "MISSING_FIELD" | "LOW_CONFIDENCE" | null;
  confidence: number | null;
  weight: number;
  points_earned: number;
  reason_code: string | null;
  evidence_doc_type: string | null;
}

export interface DimensionBreakdownEntry {
  dimension_config_id: string;
  dimension_key: string;
  dimension_name: string;
  sequence: number;
  weight: number;
  raw_score: number;
  weighted_score: number;
  is_knockout: boolean;
  knockout_threshold: number | null;
  knockout_failed: boolean;
  subcriteria: SubcriterionEvidence[];
}

export interface DimensionScore {
  evaluation_id: string;
  candidate_id: string;
  org_id: string;
  persona_id: string | null;
  template_id: string | null;
  overall_fit_score: number;
  dimension_breakdown: DimensionBreakdownEntry[];
  recommended_decision: "AUTO_PASS" | "NEEDS_REVIEW" | "AUTO_FAIL";
  knockout_triggered: boolean;
  knockout_reason: string | null;
  status: "CALCULATED" | "APPROVED" | "REJECTED" | "OVERRIDDEN";
  human_reviewer: string | null;
  human_decision: "APPROVE" | "REJECT" | "OVERRIDE" | null;
  override_reason: string | null;
  computed_by: string;
  computed_at: string;
  reviewed_at: string | null;
}

/** Full scoring history for a candidate, most recent first — see GET /candidates/:id/dimension-scores. */
export function useDimensionScores(candidateId: string | null) {
  return useQuery({
    queryKey: ["dimension-scores", candidateId],
    queryFn: () =>
      authedRequest<{ dimension_scores: DimensionScore[]; count: number }>(
        `${API_V1}/candidates/${candidateId}/dimension-scores`
      ),
    enabled: enabled() && !!candidateId,
  });
}

/** Human approve/reject/override of a dimension scoring run — see PATCH .../dimension-scores/:evaluation_id. */
export function useResolveDimensionScore(candidateId: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      evaluationId,
      decision,
      override_reason,
    }: {
      evaluationId: string;
      decision: "APPROVE" | "REJECT" | "OVERRIDE";
      override_reason?: string;
    }) =>
      authedRequest<{ dimension_score: DimensionScore }>(
        `${API_V1}/candidates/${candidateId}/dimension-scores/${evaluationId}`,
        { method: "PATCH", body: JSON.stringify({ decision, override_reason }) }
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["dimension-scores", candidateId] }),
  });
}

/** Triggers a fresh scoring run for one or more candidates — see POST /evaluations/dimension-run. */
export function useRunDimensionScoring(candidateId: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ personaId }: { personaId?: string } = {}) =>
      authedRequest<{ results: Array<{ candidate_id: string; evaluation_id?: string; error?: string }>; count: number }>(
        `${API_V1}/evaluations/dimension-run`,
        {
          method: "POST",
          body: JSON.stringify({ candidate_ids: candidateId ? [candidateId] : [], persona_id: personaId }),
        }
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["dimension-scores", candidateId] }),
  });
}

export interface DimensionTemplate {
  template_id: string;
  code: string;
  name: string;
  description: string | null;
  is_builtin: boolean;
}

/** Built-in + org-saved dimension templates (UROS Core 7, Industry 7, ...) — see GET /dimensions/templates. */
export function useDimensionTemplates() {
  return useQuery({
    queryKey: ["dimension-templates"],
    queryFn: () => authedRequest<{ templates: DimensionTemplate[]; count: number }>(`${API_V1}/dimensions/templates`),
    enabled: enabled(),
  });
}
