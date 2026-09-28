export type RuleType =
  | "ELIGIBILITY" | "QUOTA" | "SCORING" | "KNOCKOUT"
  | "WORKFLOW" | "COMMUNICATION" | "VERIFICATION";
export type Operator = "EQ" | "NEQ" | "LT" | "LTE" | "GT" | "GTE" | "IN" | "NOT_IN" | "REGEX";
export type ThresholdType = "exact" | "numeric_band";

export interface RulePack {
  rule_pack_id: string;
  org_id: string;
  name: string;
  sector: string;
  circular_id: string | null;
  is_active: boolean;
  created_by: string | null;
  created_at: string;
}

export interface RulePackVersion {
  version_id: string;
  rule_pack_id: string;
  version_number: number;
  change_summary: string | null;
  created_by: string | null;
  created_at: string;
}

export interface Rule {
  rule_id: string;
  rule_pack_version_id: string;
  rule_code: string;
  rule_type: RuleType;
  field_path: string;
  operator: Operator;
  threshold_type: ThresholdType;
  threshold_value: unknown; // number | string | string[] | number[]
  review_margin: number | null;
  min_confidence_threshold: number;
  fail_reason_code: string;
  is_knockout: boolean;
  weight: number | null;
  active: boolean;
  created_at: string;
}
