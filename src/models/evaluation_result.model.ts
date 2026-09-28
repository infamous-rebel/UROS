export type EvalStatus = "PASS" | "FAIL" | "NEEDS_REVIEW";
export type HumanDecision = "APPROVE" | "REJECT" | "OVERRIDE";

export interface EvaluationResult {
  evaluation_id: string;
  candidate_id: string;
  rule_id: string;
  rule_pack_version_id: string;
  input_value: unknown;
  status: EvalStatus;
  reason_code: string;
  confidence: number | null;
  distance_to_threshold: number | null;
  evaluated_by: string;
  evaluated_at: string;
  human_reviewer: string | null;
  human_decision: HumanDecision | null;
  override_reason: string | null;
  reviewed_at: string | null;
}
