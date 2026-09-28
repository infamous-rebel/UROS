import { Rule } from "../../models/rule.model";
import { RuleConflictError } from "../../utils/errors";

interface Conflict {
  rule_a: string;
  rule_b: string;
  reason: string;
}

/**
 * Detects contradictory rules within the same rule_pack_version + field_path
 * + rule_type. Two rules "conflict" if there exists a value that would
 * satisfy one but be structurally impossible to also satisfy the other
 * under the same knockout classification — e.g. LTE 30 (knockout) vs
 * GTE 32 (knockout) on the same field with no overlapping valid range,
 * OR two knockout rules with directly opposing EQ/NEQ on the same value.
 *
 * This is a static, deterministic check — no ML/inference.
 */
export function checkRuleConflicts(rules: Rule[]): Conflict[] {
  const conflicts: Conflict[] = [];

  const byField = new Map<string, Rule[]>();
  for (const rule of rules) {
    if (!rule.active) continue;
    const key = `${rule.field_path}::${rule.rule_type}`;
    const group = byField.get(key) ?? [];
    group.push(rule);
    byField.set(key, group);
  }

  for (const group of byField.values()) {
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const a = group[i];
        const b = group[j];
        const conflict = detectPairConflict(a, b);
        if (conflict) conflicts.push(conflict);
      }
    }
  }

  return conflicts;
}

function detectPairConflict(a: Rule, b: Rule): Conflict | null {
  // Direct contradiction: EQ x vs NEQ x on same field
  if (a.operator === "EQ" && b.operator === "NEQ" && a.threshold_value === b.threshold_value) {
    return { rule_a: a.rule_id, rule_b: b.rule_id, reason: "EQ/NEQ contradiction on same value" };
  }
  if (a.operator === "NEQ" && b.operator === "EQ" && a.threshold_value === b.threshold_value) {
    return { rule_a: a.rule_id, rule_b: b.rule_id, reason: "EQ/NEQ contradiction on same value" };
  }

  // Two EQ rules on the same field with different exact values
  if (a.operator === "EQ" && b.operator === "EQ" && a.threshold_value !== b.threshold_value) {
    return { rule_a: a.rule_id, rule_b: b.rule_id, reason: "Two EQ rules require mutually exclusive exact values" };
  }

  // Numeric range impossibility: e.g. GT 30 (knockout) vs LT 20 (knockout) — empty intersection
  const numericOps = ["LT", "LTE", "GT", "GTE"];
  if (
    numericOps.includes(a.operator) && numericOps.includes(b.operator) &&
    typeof a.threshold_value === "number" && typeof b.threshold_value === "number" &&
    a.is_knockout && b.is_knockout
  ) {
    const lower = a.operator === "GT" || a.operator === "GTE" ? a : b.operator === "GT" || b.operator === "GTE" ? b : null;
    const upper = a.operator === "LT" || a.operator === "LTE" ? a : b.operator === "LT" || b.operator === "LTE" ? b : null;
    if (lower && upper && lower !== upper) {
      const lowBound = lower.threshold_value as number;
      const highBound = upper.threshold_value as number;
      const lowInclusive = lower.operator === "GTE";
      const highInclusive = upper.operator === "LTE";
      const emptyRange =
        lowBound > highBound ||
        (lowBound === highBound && !(lowInclusive && highInclusive));
      if (emptyRange) {
        return {
          rule_a: a.rule_id,
          rule_b: b.rule_id,
          reason: `Knockout range is empty: ${lower.operator} ${lowBound} AND ${upper.operator} ${highBound}`,
        };
      }
    }
  }

  return null;
}

/** Throws if conflicts exist — call before activating a rule pack version. */
export function assertNoConflicts(rules: Rule[]): void {
  const conflicts = checkRuleConflicts(rules);
  if (conflicts.length > 0) {
    throw new RuleConflictError(
      `Rule pack has ${conflicts.length} conflict(s)`,
      conflicts.flatMap((c) => [c.rule_a, c.rule_b])
    );
  }
}
