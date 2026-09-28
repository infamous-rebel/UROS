/** Feature 8: Recruitment Analytics & Source Effectiveness — types. */

import { CandidateStatus, SourcePlatform } from "./candidate.model";

/** Same closed set as candidates.source_platform (0003_candidates.sql). Reuses the existing Candidate model's SourcePlatform type rather than redefining it. */
export const SOURCE_PLATFORMS: SourcePlatform[] = ["Teletalk", "bdjobs", "LinkedIn", "Email", "WhatsApp", "CSV"];
export type { SourcePlatform };

/**
 * Configurable underperformance thresholds. A metric below (or above,
 * for cost) its threshold produces a flag via flagUnderperformance in
 * the agent. Any field left unset disables that particular flag type —
 * never a silent default that could surprise an org.
 */
export interface UnderperformanceThresholds {
  min_pass_rate?: number; // 0..1
  min_selection_rate?: number; // 0..1
  max_cost_per_quality_hire?: number; // currency units, org-defined
}

/**
 * What counts as a "quality hire" for cost-per-quality-hire purposes.
 * hire_statuses: candidates.status values that count as a hire at all
 * (default: SELECTED). min_score: optional additional bar against the
 * candidate's latest scoring_results.total_score.
 */
export interface QualityHireDefinition {
  hire_statuses: CandidateStatus[];
  min_score: number | null;
  thresholds: UnderperformanceThresholds;
}

export interface RecruitmentAnalyticsConfig {
  config_id: string;
  org_id: string;
  quality_hire_definition: QualityHireDefinition;
  default_time_window_days: number;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface RecruitmentSourceCost {
  cost_id: string;
  org_id: string;
  source_platform: SourcePlatform;
  campaign_id: string | null;
  cost: number;
  effective_date: string; // ISO date
  created_by: string | null;
  created_at: string;
}

/** Minimal candidate projection the analytics agent operates on. Never phantom data — every field maps 1:1 to a candidates column. */
export interface AnalyticsCandidateRow {
  candidate_id: string;
  source_platform: SourcePlatform | null;
  job_circular_id: string | null;
  status: CandidateStatus;
  window_date: string; // COALESCE(application_date, created_at), ISO datetime
}

/** Reduced eligibility outcome for one candidate from its evaluation_results rows. */
export type EligibilityOutcome = "PASS" | "FAIL" | "NEEDS_REVIEW" | "NOT_EVALUATED";

export interface SourceEffectivenessMetrics {
  source_platform: SourcePlatform;
  total_candidates: number;
  eligible_pass_count: number;
  interview_count: number;
  selection_count: number;
  pass_rate: number; // eligible_pass_count / total_candidates
  interview_rate: number; // interview_count / total_candidates
  selection_rate: number; // selection_count / total_candidates
}

export type UnderperformanceFlagReasonCode =
  | "SOURCE_PASS_RATE_BELOW_THRESHOLD"
  | "SOURCE_SELECTION_RATE_BELOW_THRESHOLD"
  | "SOURCE_COST_PER_QUALITY_HIRE_ABOVE_THRESHOLD"
  | "SOURCE_ZERO_QUALITY_HIRES_WITH_SPEND";

/** Every UROS_Global_Reasoning_Standard.md field, on every flag. */
export interface UnderperformanceFlag {
  source_platform: SourcePlatform;
  reason_code: UnderperformanceFlagReasonCode;
  reason_description: string;
  evidence: Record<string, unknown>;
}

export interface SourceEffectivenessReport {
  org_id: string;
  window_start: string; // ISO date
  window_end: string; // ISO date
  circular_id: string | null;
  sources: SourceEffectivenessMetrics[];
  flags: UnderperformanceFlag[];
  reason_code: string;
  reason_description: string;
  evidence: Record<string, unknown>;
}

export interface FunnelStage {
  stage: "APPLIED" | "ELIGIBLE" | "SCORED" | "SHORTLISTED" | "COMMUNICATED" | "SELECTED";
  count: number;
}

export interface FunnelAnalysisReport {
  org_id: string;
  circular_id: string;
  stages: FunnelStage[];
  reason_code: string;
  reason_description: string;
  evidence: Record<string, unknown>;
}

export interface QualityHireSourceCost {
  source_platform: SourcePlatform;
  total_cost: number;
  quality_hire_count: number;
  cost_per_quality_hire: number | null; // null when quality_hire_count is 0 (undefined, not zero/Infinity)
}

export interface QualityHireReport {
  org_id: string;
  window_start: string;
  window_end: string;
  quality_hire_definition: QualityHireDefinition;
  sources: QualityHireSourceCost[];
  flags: UnderperformanceFlag[];
  reason_code: string;
  reason_description: string;
  evidence: Record<string, unknown>;
}
