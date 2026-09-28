import { Operator } from "./rule.model";

export interface DimensionTemplate {
  template_id: string;
  org_id: string | null; // NULL = built-in, available to every org
  code: string; // e.g. UROS_CORE_7, INDUSTRY_7
  name: string;
  description: string | null;
  is_builtin: boolean;
  created_by: string | null;
  created_at: string;
}

export interface DimensionConfig {
  dimension_config_id: string;
  org_id: string | null; // NULL = template default row, never scored directly
  template_id: string | null;
  persona_id: string | null;
  dimension_key: string;
  dimension_name: string;
  sequence: number;
  weight: number; // 0-100, normalized against sibling dimensions at scoring time
  is_knockout: boolean;
  knockout_threshold: number | null; // dimension raw_score (0-100) below which the candidate is knocked out
  version: number;
  active: boolean;
  created_by: string | null;
  created_at: string;
}

export interface DimensionSubcriterion {
  subcriterion_id: string;
  dimension_config_id: string;
  field_path: string; // dotted path into the assembled candidate profile
  label: string;
  operator: Operator;
  threshold_value: unknown;
  weight: number; // 0+, normalized to 100 within the dimension
  evidence_doc_type: string | null;
  reason_code: string;
  active: boolean;
  created_at: string;
}

export type DimensionRecommendedDecision = "AUTO_PASS" | "NEEDS_REVIEW" | "AUTO_FAIL";
export type DimensionScoreStatus = "CALCULATED" | "APPROVED" | "REJECTED" | "OVERRIDDEN";
export type DimensionHumanDecision = "APPROVE" | "REJECT" | "OVERRIDE";

/** Per-sub-criterion evidence recorded inside a dimension's breakdown — the "no black box" contract for this feature. */
export interface SubcriterionEvidence {
  subcriterion_id: string;
  field_path: string;
  label: string;
  operator: Operator;
  threshold_value: unknown;
  extracted_value: unknown;
  matched: boolean;
  flagged: boolean; // true when missing field / low confidence prevented a real evaluation
  flag_reason: "MISSING_FIELD" | "LOW_CONFIDENCE" | null;
  confidence: number | null;
  weight: number; // raw configured weight
  points_earned: number; // 0-100 share of this dimension's 100 normalized points
  reason_code: string | null; // present when not matched
  evidence_doc_type: string | null;
}

/** Per-dimension breakdown stored in candidate_dimension_scores.dimension_breakdown. */
export interface DimensionBreakdownEntry {
  dimension_config_id: string;
  dimension_key: string;
  dimension_name: string;
  sequence: number;
  weight: number; // configured weight (pre-normalization)
  raw_score: number; // 0-100, this dimension alone
  weighted_score: number; // raw_score * normalized_weight / 100
  is_knockout: boolean;
  knockout_threshold: number | null;
  knockout_failed: boolean;
  subcriteria: SubcriterionEvidence[];
}

export interface CandidateDimensionScore {
  evaluation_id: string;
  candidate_id: string;
  org_id: string;
  persona_id: string | null;
  template_id: string | null;
  overall_fit_score: number;
  dimension_breakdown: DimensionBreakdownEntry[];
  recommended_decision: DimensionRecommendedDecision;
  knockout_triggered: boolean;
  knockout_reason: string | null;
  status: DimensionScoreStatus;
  human_reviewer: string | null;
  human_decision: DimensionHumanDecision | null;
  override_reason: string | null;
  computed_by: string;
  computed_at: string;
  reviewed_at: string | null;
}

/** Flat, deterministic candidate profile assembled from existing tables for dimension sub-criteria evaluation. */
export interface CandidateDimensionProfile {
  candidate_id: string;
  full_name: string;
  district: string | null;
  division: string | null;
  source_platform: string | null;
  position_applied: string | null;
  job_circular_id: string | null;
  status: string;
  age_years: number | null;
  academic: Record<string, AcademicLevelProfile>; // keyed by lowercase level: ssc, hsc, bachelor, masters, diploma, other
  highest_education_level: string | null;
  highest_cgpa: number | null;
  total_experience_years: number;
  experience_count: number;
  current_organization: string | null;
  current_designation: string | null;
  quota: {
    quota_type: string | null;
    applied_quota_flag: boolean;
  };
  documents_total: number;
  documents_verified: number;
  documents_verified_ratio: number;
  [key: string]: unknown;
}

export interface AcademicLevelProfile {
  cgpa: number | null;
  division_class: string | null;
  passing_year: number | null;
  institution: string | null;
  board_or_university: string | null;
  result_scale: string | null;
  field_confidence: number | null;
}
