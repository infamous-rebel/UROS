import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { authedRequest, API_V1, getToken } from "../api/client";

const enabled = () => !!getToken();

export type ReferenceRequestStatus = "PENDING" | "SENT" | "COMPLETED" | "EXPIRED" | "CANCELLED";
export type ReferenceRecommendation = "RECOMMEND" | "NEEDS_REVIEW" | "CONCERN";
export type ReferenceReviewDecision = "APPROVED" | "REJECTED" | "ESCALATED";

export interface ReferenceRequestRow {
  request_id: string;
  org_id: string;
  candidate_id: string;
  referee_email: string | null;
  referee_phone: string | null;
  persona_id: string | null;
  question_set_id: string;
  status: ReferenceRequestStatus;
  expires_at: string;
  created_at: string;
  sent_at: string | null;
  reminder_count: number;
  completed_at: string | null;
  // Joined from reference_results, when scored:
  result_id: string | null;
  total_score: number | null;
  max_score: number | null;
  recommendation: ReferenceRecommendation | null;
  review_decision: ReferenceReviewDecision | null;
  reviewed_at: string | null;
}

export interface ReferenceQuestion {
  question_id: string;
  text: string;
  type: "RATING_1_5" | "YES_NO" | "TEXT";
  weight: number;
}

export interface ReferenceQuestionSet {
  question_set_id: string;
  org_id: string;
  persona_id: string | null;
  name: string;
  questions: ReferenceQuestion[];
  version: number;
  active: boolean;
}

export interface ReferenceScoreResult {
  result_id: string;
  request_id: string;
  candidate_id: string;
  total_score: number;
  max_score: number;
  recommendation: ReferenceRecommendation;
  reason_code: string;
  reason_description: string;
  evidence: Record<string, unknown>;
  reviewer_id: string | null;
  review_decision: ReferenceReviewDecision | null;
  review_reason: string | null;
  reviewed_at: string | null;
}

/** All reference requests for a candidate (with score/review joined in) — see GET /references/requests/:candidate_id. */
export function useReferenceRequests(candidateId: string | null) {
  return useQuery({
    queryKey: ["reference-requests", candidateId],
    queryFn: () =>
      authedRequest<{ requests: ReferenceRequestRow[]; count: number }>(`${API_V1}/references/requests/${candidateId}`),
    enabled: enabled() && !!candidateId,
  });
}

/** Sends a reference check request to a referee — see POST /references/request. */
export function useCreateReferenceRequest(candidateId: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { candidate_id: string; referee_email?: string; referee_phone?: string; persona_id?: string }) =>
      authedRequest<{ request: ReferenceRequestRow; respond_token: string; respond_url: string }>(
        `${API_V1}/references/request`,
        { method: "POST", body: JSON.stringify(body) }
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["reference-requests", candidateId] }),
  });
}

/** Triggers deterministic scoring for a completed request — see POST /references/requests/:request_id/score. */
export function useScoreReferenceRequest(candidateId: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (requestId: string) =>
      authedRequest<{ result: ReferenceScoreResult }>(`${API_V1}/references/requests/${requestId}/score`, {
        method: "POST",
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["reference-requests", candidateId] }),
  });
}

/** Human review: approve/reject/escalate a scored result, mandatory reason — see PATCH /references/results/:result_id. */
export function useReviewReferenceResult(candidateId: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      resultId,
      review_decision,
      review_reason,
    }: {
      resultId: string;
      review_decision: ReferenceReviewDecision;
      review_reason: string;
    }) =>
      authedRequest<{ result: ReferenceScoreResult }>(`${API_V1}/references/results/${resultId}`, {
        method: "PATCH",
        body: JSON.stringify({ review_decision, review_reason }),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["reference-requests", candidateId] }),
  });
}

/** Configures the question set for a persona (or org-wide default) — see POST /references/configure. */
export function useConfigureReferenceQuestions() {
  return useMutation({
    mutationFn: (body: { persona_id?: string | null; name: string; questions: ReferenceQuestion[] }) =>
      authedRequest<{ question_set: ReferenceQuestionSet }>(`${API_V1}/references/configure`, {
        method: "POST",
        body: JSON.stringify(body),
      }),
  });
}
