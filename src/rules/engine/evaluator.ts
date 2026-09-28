import { db } from "../../database/client";
import { logAudit } from "../../utils/audit_helper";
import { applyOperator } from "./operators";
import { Candidate } from "../../models/candidate.model";
import { Rule } from "../../models/rule.model";
import { EvalStatus } from "../../models/evaluation_result.model";
import { RuleEvaluationError } from "../../utils/errors";

export interface EvalOutcome {
  candidate_id: string;
  rule_id: string;
  rule_pack_version_id: string;
  input_value: unknown;
  status: EvalStatus;
  reason_code: string;
  confidence: number | null;
  distance_to_threshold: number | null;
  evaluated_by: string;
}

/** Reads a dotted field path (e.g. "academic.hsc.cgpa") from a candidate object. */
function extractField(candidate: Candidate, path: string): unknown {
  const segments = path.split(".");
  let node: any = candidate;
  for (const segment of segments) {
    if (node === null || node === undefined) return null;
    node = node[segment];
  }
  return node === undefined ? null : node;
}

function getFieldConfidence(candidate: Candidate, path: string): number | null {
  return candidate.__confidence?.[path] ?? null;
}

/**
 * Deterministic rule evaluation: same (candidate, rule) always yields
 * the same output. Persists to evaluation_results + audit_log.
 */
export async function evaluateRule(
  candidate: Candidate,
  rule: Rule,
  actor: string = "SYSTEM"
): Promise<EvalOutcome> {
  const fieldValue = extractField(candidate, rule.field_path);
  const confidence = getFieldConfidence(candidate, rule.field_path);

  // Guard 1: missing field
  if (fieldValue === null || fieldValue === undefined) {
    return persist(candidate, rule, fieldValue, "NEEDS_REVIEW", "MISSING_FIELD", confidence, actor, null);
  }

  // Guard 2: low-confidence extraction
  if (confidence !== null && confidence < rule.min_confidence_threshold) {
    return persist(candidate, rule, fieldValue, "NEEDS_REVIEW", "OCR_LOW_CONFIDENCE", confidence, actor, null);
  }

  // Core evaluation
  let rawPass: boolean;
  try {
    rawPass = applyOperator(fieldValue, rule.operator, rule.threshold_value);
  } catch (err) {
    const reasonCode = err instanceof RuleEvaluationError ? "RULE_EXCEPTION" : "RULE_EXCEPTION";
    return persist(candidate, rule, fieldValue, "NEEDS_REVIEW", reasonCode, confidence, actor, null);
  }

  // Borderline / review-margin check (numeric_band only)
  if (rule.threshold_type === "numeric_band" && rule.review_margin != null) {
    if (typeof fieldValue === "number" && typeof rule.threshold_value === "number") {
      const distance = Math.abs(fieldValue - rule.threshold_value);
      if (distance <= rule.review_margin) {
        return persist(
          candidate, rule, fieldValue, "NEEDS_REVIEW",
          `BORDERLINE_${rule.rule_code}`, confidence, actor, distance
        );
      }
    }
  }

  const status: EvalStatus = rawPass ? "PASS" : "FAIL";
  const reasonCode = rawPass ? "OK" : rule.fail_reason_code;
  return persist(candidate, rule, fieldValue, status, reasonCode, confidence, actor, null);
}

async function persist(
  candidate: Candidate,
  rule: Rule,
  fieldValue: unknown,
  status: EvalStatus,
  reasonCode: string,
  confidence: number | null,
  actor: string,
  distance: number | null
): Promise<EvalOutcome> {
  const outcome: EvalOutcome = {
    candidate_id: candidate.candidate_id,
    rule_id: rule.rule_id,
    rule_pack_version_id: rule.rule_pack_version_id,
    input_value: fieldValue,
    status,
    reason_code: reasonCode,
    confidence,
    distance_to_threshold: distance,
    evaluated_by: actor,
  };

  await db.query(
    `INSERT INTO evaluation_results
      (candidate_id, rule_id, rule_pack_version_id, input_value, status,
       reason_code, confidence, distance_to_threshold, evaluated_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [
      outcome.candidate_id, outcome.rule_id, outcome.rule_pack_version_id,
      JSON.stringify(outcome.input_value), outcome.status, outcome.reason_code,
      outcome.confidence, outcome.distance_to_threshold, outcome.evaluated_by,
    ]
  );

  await logAudit({
    entity_type: "EVALUATION",
    entity_id: outcome.candidate_id,
    agent_or_user: actor,
    action: "RULE_EVALUATED",
    rule_id: rule.rule_id,
    input_value: outcome.input_value,
    output_value: outcome.status,
    reason_code: outcome.reason_code,
  });

  return outcome;
}

export async function applyHumanOverride(
  evaluationId: string,
  reviewerId: string,
  decision: "APPROVE" | "REJECT" | "OVERRIDE",
  reasonComment: string
): Promise<void> {
  if (!reasonComment || reasonComment.trim().length === 0) {
    throw new RuleEvaluationError("Override requires a mandatory reason comment");
  }

  await db.query(
    `UPDATE evaluation_results
     SET human_reviewer=$1, human_decision=$2, override_reason=$3, reviewed_at=now()
     WHERE evaluation_id=$4`,
    [reviewerId, decision, reasonComment, evaluationId]
  );

  await logAudit({
    entity_type: "OVERRIDE",
    entity_id: evaluationId,
    agent_or_user: reviewerId,
    action: "HUMAN_OVERRIDE",
    output_value: decision,
    reason_code: "HUMAN_OVERRIDE",
    reason_comment: reasonComment,
  });
}
