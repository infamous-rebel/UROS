import { db } from "../../database/client";
import { evaluateRule, EvalOutcome } from "../../rules/engine/evaluator";
import { logAudit } from "../../utils/audit_helper";
import { Candidate } from "../../models/candidate.model";
import { Rule } from "../../models/rule.model";
import { EvalStatus } from "../../models/evaluation_result.model";

/**
 * The Eligibility Agent's output for one candidate. This is a
 * RECOMMENDATION only — per UROS core principle #4 (agents recommend,
 * humans decide), runEligibility never writes to candidates.status and
 * never enqueues a human review itself; the orchestrator/HIL Supervisor
 * owns those decisions using this recommendation as input.
 */
export interface EligibilityRecommendation {
  candidate_id: string;
  rule_pack_version_id: string;
  status: EvalStatus; // PASS | FAIL | NEEDS_REVIEW
  reason_codes: string[]; // every non-OK reason_code encountered, in rule evaluation order
  evidence: EvalOutcome[]; // the full per-rule trail: rule_id, input_value, status, reason_code, confidence
}

/**
 * Runs a candidate against every active ELIGIBILITY rule in the given
 * rule pack version and produces a deterministic aggregate
 * recommendation. Reuses the existing rule engine (`evaluateRule`) for
 * every individual rule check — this agent adds no new evaluation
 * semantics of its own, it only orchestrates and aggregates.
 *
 * `evaluateRule` already persists each per-rule outcome to
 * evaluation_results and logs an audit_log "RULE_EVALUATED" entry (see
 * src/rules/engine/evaluator.ts). This function additionally logs one
 * summary audit_log entry ("ELIGIBILITY_RECOMMENDATION_COMPUTED") per
 * candidate so the aggregate recommendation itself — not just its
 * individual rule checks — is independently auditable.
 *
 * Aggregation rules (deterministic, same input always yields the same
 * output):
 *   - Any FAIL on a knockout rule short-circuits the remaining rules
 *     and the overall recommendation is FAIL.
 *   - Any FAIL (knockout or not) sets overall FAIL, but non-knockout
 *     FAILs do not stop evaluation of the remaining rules — every rule
 *     still contributes its own evidence/reason_code.
 *   - Any NEEDS_REVIEW (missing field, low OCR confidence, borderline
 *     numeric band, or a rule evaluation exception) sets overall
 *     NEEDS_REVIEW, unless a FAIL has already been recorded — FAIL
 *     always takes precedence over NEEDS_REVIEW in the aggregate.
 *   - If every rule PASSes, the overall recommendation is PASS.
 */
export async function runEligibility(
  candidate: Candidate,
  rulePackVersionId: string,
  actor: string = "EligibilityAgent"
): Promise<EligibilityRecommendation> {
  const rulesRes = await db.query<Rule>(
    `SELECT * FROM rules WHERE rule_pack_version_id=$1 AND rule_type='ELIGIBILITY' AND active=true`,
    [rulePackVersionId]
  );

  let overall: EvalStatus = "PASS";
  const reasonCodes: string[] = [];
  const evidence: EvalOutcome[] = [];

  for (const rule of rulesRes.rows) {
    const result = await evaluateRule(candidate, rule, actor);
    evidence.push(result);
    if (result.reason_code !== "OK") reasonCodes.push(result.reason_code);

    if (result.status === "FAIL") {
      overall = "FAIL";
      if (rule.is_knockout) break; // deterministic short-circuit — no further rules evaluated
    } else if (result.status === "NEEDS_REVIEW" && overall !== "FAIL") {
      overall = "NEEDS_REVIEW";
    }
  }

  await logAudit({
    org_id: candidate.org_id,
    entity_type: "ELIGIBILITY_RECOMMENDATION",
    entity_id: candidate.candidate_id,
    agent_or_user: actor,
    action: "ELIGIBILITY_RECOMMENDATION_COMPUTED",
    output_value: { status: overall, reason_codes: reasonCodes, rules_evaluated: evidence.length },
    reason_code: overall,
    reason_comment:
      overall === "PASS"
        ? "All active eligibility rules passed."
        : `Recommendation: ${overall}. Reason codes: ${reasonCodes.join(", ") || "none"}.`,
  });

  return {
    candidate_id: candidate.candidate_id,
    rule_pack_version_id: rulePackVersionId,
    status: overall,
    reason_codes: reasonCodes,
    evidence,
  };
}

/**
 * Convenience batch wrapper: runs runEligibility for every candidate
 * matching a job circular. Read-heavy callers (reports, dashboards)
 * that need eligibility recommendations without driving the full
 * orchestrator pipeline can use this directly. Each candidate is
 * evaluated independently — one candidate's failure never blocks the
 * rest of the batch.
 */
export async function runEligibilityForCircular(
  circularId: string,
  rulePackVersionId: string,
  actor: string = "EligibilityAgent"
): Promise<EligibilityRecommendation[]> {
  // Quest 02: resolve org_id from the circular's candidates to scope the query.
  // The circular_id alone is not enough — we need the org to prevent cross-tenant leakage.
  const orgRes = await db.query<{ org_id: string }>(
    `SELECT DISTINCT org_id FROM candidates WHERE job_circular_id=$1 LIMIT 1`,
    [circularId]
  );
  const orgId = orgRes.rows[0]?.org_id;
  if (!orgId) {
    return [];
  }

  const candidatesRes = await db.query<Candidate>(
    `SELECT * FROM candidates WHERE job_circular_id=$1 AND org_id=$2`,
    [circularId, orgId]
  );

  const results: EligibilityRecommendation[] = [];
  for (const candidate of candidatesRes.rows) {
    try {
      results.push(await runEligibility(candidate, rulePackVersionId, actor));
    } catch (err) {
      // Never let one candidate's evaluation exception abort the batch —
      // matches the "never silently drops a candidate" principle.
      await logAudit({
        org_id: candidate.org_id,
        entity_type: "ELIGIBILITY_RECOMMENDATION",
        entity_id: candidate.candidate_id,
        agent_or_user: actor,
        action: "ELIGIBILITY_RECOMMENDATION_FAILED",
        reason_code: "AGENT_ERROR",
        reason_comment: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return results;
}
