import { SupportedLanguage } from "./organization.model";

export type CandidateStatus =
  | "INTAKE" | "PARSED" | "ELIGIBILITY_DONE" | "SCORED" | "NEEDS_REVIEW"
  | "ELIGIBLE_APPROVED" | "SHORTLISTED" | "VERIFIED" | "REJECTED"
  | "SELECTED" | "WITHDRAWN";

export type SourcePlatform = "Teletalk" | "bdjobs" | "LinkedIn" | "Email" | "WhatsApp" | "CSV";
export type DataConfidence = "High" | "Medium" | "Low";

export interface Candidate {
  candidate_id: string;
  org_id: string;
  full_name: string;
  father_name: string | null;
  mother_name: string | null;
  date_of_birth: string | null;
  gender: "Male" | "Female" | "Third Gender" | null;
  nationality: string;
  national_id: string | null;
  phone_primary: string | null;
  email: string | null;
  present_address: string | null;
  permanent_address: string | null;
  district: string | null;
  division: string | null;
  source_platform: SourcePlatform | null;
  application_date: string | null;
  job_circular_id: string | null;
  position_applied: string | null;
  data_confidence: DataConfidence | null;
  duplicate_of: string | null;
  status: CandidateStatus;
  /** Feature 5: drives communication-template language selection; null = fall back to org default_language. */
  preferred_language: SupportedLanguage | null;
  created_at: string;
  updated_at: string;

  // In-memory only (populated by parser), not a DB column:
  __confidence?: Record<string, number>;
  academic?: AcademicRecord[];
}

export interface AcademicRecord {
  record_id: string;
  candidate_id: string;
  level: "SSC" | "HSC" | "Bachelor" | "Masters" | "Diploma" | "Other";
  institution: string | null;
  board_or_university: string | null;
  passing_year: number | null;
  division_class: "First" | "Second" | "Third" | "CGPA" | null;
  cgpa: number | null;
  result_scale: string | null;
  field_confidence: number | null;
}
