// Feature 7: Automated Reference Checking — types.
//
// UROS_Global_Reasoning_Standard.md: every stored outcome must carry a
// reason_code, reason_description, and evidence. The agent NEVER
// produces a final decision — `recommendation` is a suggestion only;
// `review_decision` on ReferenceResult is the human's final call.

export type ReferenceQuestionType = "RATING_1_5" | "YES_NO" | "TEXT";

export interface ReferenceQuestion {
  question_id: string;
  text: string;
  type: ReferenceQuestionType;
  /** Relative weight among scorable (non-TEXT) questions. Normalized to 100 at scoring time. */
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
  created_by: string | null;
  created_at: string;
}

export type ReferenceRequestStatus = "PENDING" | "SENT" | "COMPLETED" | "EXPIRED" | "CANCELLED";

export interface ReferenceRequest {
  request_id: string;
  org_id: string;
  candidate_id: string;
  referee_email: string | null;
  referee_phone: string | null;
  persona_id: string | null;
  question_set_id: string;
  status: ReferenceRequestStatus;
  token: string; // hashed at rest
  expires_at: string;
  created_by: string | null;
  created_at: string;
  sent_at: string | null;
  reminder_count: number;
  completed_at: string | null;
}

export interface ReferenceResponseRecord {
  response_id: string;
  request_id: string;
  question_id: string;
  response_text: string | null;
  score: number | null;
  confidence: number | null;
  reason_code: string | null;
  reason_description: string | null;
  evidence: Record<string, unknown>;
  created_at: string;
}

export type ReferenceRecommendation = "RECOMMEND" | "NEEDS_REVIEW" | "CONCERN";
export type ReferenceReviewDecision = "APPROVED" | "REJECTED" | "ESCALATED";

export interface ReferenceResult {
  result_id: string;
  request_id: string;
  candidate_id: string;
  org_id: string;
  total_score: number;
  max_score: number;
  recommendation: ReferenceRecommendation;
  reason_code: string;
  reason_description: string;
  evidence: Record<string, unknown>;
  reviewer_id: string | null;
  review_decision: ReferenceReviewDecision | null;
  review_reason: string | null;
  created_at: string;
  reviewed_at: string | null;
}

/** Per-question scoring outcome computed by the agent (pure, deterministic). */
export interface QuestionScoringOutcome {
  question_id: string;
  score: number | null;
  confidence: number | null;
  reason_code: string;
  reason_description: string;
  evidence: Record<string, unknown>;
}

/** Aggregate scoring outcome computed by the agent for a full request. */
export interface ReferenceScoringOutcome {
  per_question: QuestionScoringOutcome[];
  total_score: number;
  max_score: number;
  recommendation: ReferenceRecommendation;
  reason_code: string;
  reason_description: string;
  evidence: Record<string, unknown>;
}
