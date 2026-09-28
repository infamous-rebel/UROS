import { Operator } from "../../models/rule.model";
import { RuleEvaluationError } from "../../utils/errors";

export function EQ(value: unknown, threshold: unknown): boolean {
  return value === threshold;
}

export function NEQ(value: unknown, threshold: unknown): boolean {
  return value !== threshold;
}

function assertNumeric(value: unknown, op: string): asserts value is number {
  if (typeof value !== "number" || Number.isNaN(value)) {
    throw new RuleEvaluationError(`Operator ${op} requires a numeric value, got: ${JSON.stringify(value)}`);
  }
}

export function LT(value: unknown, threshold: unknown): boolean {
  assertNumeric(value, "LT");
  assertNumeric(threshold, "LT");
  return value < threshold;
}

export function LTE(value: unknown, threshold: unknown): boolean {
  assertNumeric(value, "LTE");
  assertNumeric(threshold, "LTE");
  return value <= threshold;
}

export function GT(value: unknown, threshold: unknown): boolean {
  assertNumeric(value, "GT");
  assertNumeric(threshold, "GT");
  return value > threshold;
}

export function GTE(value: unknown, threshold: unknown): boolean {
  assertNumeric(value, "GTE");
  assertNumeric(threshold, "GTE");
  return value >= threshold;
}

export function IN(value: unknown, threshold: unknown): boolean {
  if (!Array.isArray(threshold)) {
    throw new RuleEvaluationError(`Operator IN requires an array threshold, got: ${JSON.stringify(threshold)}`);
  }
  return threshold.includes(value);
}

export function NOT_IN(value: unknown, threshold: unknown): boolean {
  return !IN(value, threshold);
}

export function REGEX(value: unknown, threshold: unknown): boolean {
  if (typeof threshold !== "string") {
    throw new RuleEvaluationError(`Operator REGEX requires a string pattern, got: ${JSON.stringify(threshold)}`);
  }
  let pattern: RegExp;
  try {
    pattern = new RegExp(threshold);
  } catch {
    throw new RuleEvaluationError(`Invalid regex pattern: ${threshold}`);
  }
  return pattern.test(String(value));
}

const OPERATOR_MAP: Record<Operator, (value: unknown, threshold: unknown) => boolean> = {
  EQ, NEQ, LT, LTE, GT, GTE, IN, NOT_IN, REGEX,
};

export function applyOperator(value: unknown, operator: Operator, threshold: unknown): boolean {
  const fn = OPERATOR_MAP[operator];
  if (!fn) {
    throw new RuleEvaluationError(`Unknown operator: ${operator}`);
  }
  return fn(value, threshold);
}
