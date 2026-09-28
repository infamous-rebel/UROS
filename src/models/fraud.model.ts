export type FraudCheckType =
  | "AGE_EDUCATION_TIMELINE"
  | "CGPA_DIVISION_CONSISTENCY"
  | "EXPERIENCE_OVERLAP"
  | "DUPLICATE_IDENTITY"
  | "IMPOSSIBLE_DOB_GRADUATION_AGE";

export const FRAUD_CHECK_TYPES: FraudCheckType[] = [
  "AGE_EDUCATION_TIMELINE",
  "CGPA_DIVISION_CONSISTENCY",
  "EXPERIENCE_OVERLAP",
  "DUPLICATE_IDENTITY",
  "IMPOSSIBLE_DOB_GRADUATION_AGE",
];

export type FraudSeverity = "LOW" | "MEDIUM" | "HIGH";
export type FraudFlagStatus = "OPEN" | "CONFIRMED" | "FALSE_POSITIVE" | "ESCALATED";
export type FraudResolution = "CONFIRMED" | "FALSE_POSITIVE" | "ESCALATED";
/** Outcome of a single deterministic check run against one candidate. PASS never produces a stored flag row. */
export type FraudCheckStatus = "PASS" | "FAIL" | "NEEDS_REVIEW";

export interface FraudCheck {
  check_id: string;
  org_id: string;
  name: string;
  check_type: FraudCheckType;
  config: Record<string, unknown>;
  is_knockout: boolean;
  active: boolean;
  created_by: string | null;
  created_at: string;
}

export interface FraudFlag {
  flag_id: string;
  org_id: string;
  candidate_id: string;
  check_id: string | null;
  check_type: FraudCheckType;
  severity: FraudSeverity;
  reason_code: string;
  reason_description: string;
  evidence: Record<string, unknown>;
  status: FraudFlagStatus;
  detected_at: string;
  reviewed_by: string | null;
  reviewed_at: string | null;
  resolution: FraudResolution | null;
  resolution_reason: string | null;
}

/** Per-config-type tolerance/threshold shapes. All are illustrative defaults (see file 12: figures are indicative, not exact) and fully org-overridable via POST /fraud/configure. */
export interface AgeEducationTimelineConfig {
  min_age_by_level: Record<string, number>;
  min_level_gap_years: number;
}

export interface CgpaDivisionConsistencyConfig {
  scale_4: { first_division_min_cgpa: number; second_division_min_cgpa: number };
  scale_5: { first_division_min_cgpa: number; second_division_min_cgpa: number };
  tolerance: number;
}

export interface ExperienceOverlapConfig {
  max_allowed_overlap_days: number;
}

export interface DuplicateIdentityConfig {
  fields: Array<"national_id" | "phone_primary" | "email">;
}

export interface ImpossibleDobGraduationConfig {
  max_plausible_age_years: number;
}

export type FraudCheckConfig =
  | AgeEducationTimelineConfig
  | CgpaDivisionConsistencyConfig
  | ExperienceOverlapConfig
  | DuplicateIdentityConfig
  | ImpossibleDobGraduationConfig;

/** Flat, deterministic profile assembled from existing candidate/academic/experience tables — no phantom data. */
export interface FraudCandidateProfile {
  candidate_id: string;
  org_id: string;
  full_name: string;
  date_of_birth: string | null; // ISO date
  national_id: string | null;
  phone_primary: string | null;
  email: string | null;
  academic: FraudAcademicEntry[];
  experience: FraudExperienceEntry[];
}

export interface FraudAcademicEntry {
  level: string | null;
  passing_year: number | null;
  division_class: string | null;
  cgpa: number | null;
  result_scale: string | null;
}

export interface FraudExperienceEntry {
  organization: string | null;
  designation: string | null;
  start_date: string | null; // ISO date
  end_date: string | null; // ISO date, null = ongoing
  is_current: boolean;
}

/** Minimal shape of another org candidate used only for the duplicate-identity check. */
export interface OtherCandidateIdentity {
  candidate_id: string;
  national_id: string | null;
  phone_primary: string | null;
  email: string | null;
}

/** The result of one deterministic check function — always carries the Global Reasoning Standard fields. */
export interface FraudCheckOutcome {
  check_type: FraudCheckType;
  status: FraudCheckStatus;
  severity: FraudSeverity;
  reason_code: string;
  reason_description: string;
  evidence: Record<string, unknown>;
}

export interface FraudDetectionCandidateResult {
  candidate_id: string;
  checks_run: number;
  flags_created: Array<{ check_type: FraudCheckType; status: FraudCheckStatus; reason_code: string; flag_id: string | null }>;
  error?: string;
}
