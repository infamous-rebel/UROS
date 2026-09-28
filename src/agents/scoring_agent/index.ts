import { Candidate } from "../../models/candidate.model";
import { Rule } from "../../models/rule.model";
import { applyOperator } from "../../rules/engine/operators";

export interface ScoringOutcome {
  score: number;
  breakdown: Record<string, number>;
}

/** Reads a dotted field path from a candidate object, mirroring the evaluator. */
function extractField(candidate: Candidate, path: string): unknown {
  return path.split(".").reduce<any>((node, segment) => (node == null ? null : node[segment]), candidate);
}

/**
 * Deterministic, rule-defined scoring — no hidden model or learned
 * weights. Two contribution modes, both fully explainable per-rule:
 *
 *  1. Threshold/match rules (EQ, IN, etc.) — full `weight` points if the
 *     condition is met, 0 otherwise. Matches checklist-style rubrics
 *     (e.g. "+5 if JAIBB certified").
 *
 *  2. Numeric comparison rules against a numeric threshold_value where
 *     threshold_value represents the reference maximum for that field
 *     (e.g. CGPA rule with threshold_value=5 means "CGPA out of 5") —
 *     contributes `weight * (fieldValue / threshold_value)`, capped at
 *     `weight`. Matches proportional rubrics (e.g. "HSC GPA × 10 points",
 *     file 09 §5 / file 20 §7.4).
 *
 * Assumption (stated once): mode 2 requires `threshold_value` to hold the
 * reference maximum rather than a pass/fail cutoff for SCORING-type rules
 * specifically — eligibility/knockout rules are unaffected and keep using
 * threshold_value as a cutoff via the evaluator.
 */
export async function compute(candidate: Candidate, scoringRules: Rule[]): Promise<ScoringOutcome> {
  const breakdown: Record<string, number> = {};
  let total = 0;

  for (const rule of scoringRules) {
    const fieldValue = extractField(candidate, rule.field_path);
    const weight = rule.weight ?? 0;

    if (fieldValue === null || fieldValue === undefined) {
      breakdown[rule.rule_code] = 0;
      continue;
    }

    const isProportional =
      typeof fieldValue === "number" &&
      typeof rule.threshold_value === "number" &&
      ["GTE", "GT", "LTE", "LT"].includes(rule.operator);

    let points: number;
    if (isProportional) {
      const ratio = (fieldValue as number) / (rule.threshold_value as number);
      points = Math.max(0, Math.min(weight, weight * ratio));
    } else {
      let matched = false;
      try {
        matched = applyOperator(fieldValue, rule.operator, rule.threshold_value);
      } catch {
        matched = false; // scoring never throws; a bad match just contributes 0
      }
      points = matched ? weight : 0;
    }

    breakdown[rule.rule_code] = Math.round(points * 100) / 100;
    total += breakdown[rule.rule_code];
  }

  return { score: Math.round(total * 100) / 100, breakdown };
}
