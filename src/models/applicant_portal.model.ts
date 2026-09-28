export type OtpChannel = "EMAIL" | "SMS";

export interface ApplicantOtpRequest {
  request_id: string;
  candidate_id: string;
  channel: OtpChannel;
  code_hash: string;
  expires_at: string;
  consumed_at: string | null;
  attempts: number;
  max_attempts: number;
  created_at: string;
}

export interface ApplicantPortalConfig {
  org_id: string;
  visible_reason_codes: string[] | null; // null = show all
  estimated_timeline_text: string;
  appeal_enabled: boolean;
  localized_messages: Record<string, { estimated_timeline_text?: string; next_update_text?: string }>;
  default_language: string;
  updated_by: string | null;
  updated_at: string;
}

/**
 * Global Reasoning Standard contract: every reason surfaced to the
 * applicant carries a reason_code, a plain-language reason_description,
 * and structured evidence (rule applied, extracted value, documents
 * considered) — never a bare status.
 */
export interface ApplicantReasonEntry {
  reason_code: string;
  reason_description: string;
  status: "FAIL" | "NEEDS_REVIEW" | "PASS";
  evidence: {
    rule_applied: string;
    field_path: string;
    extracted_value: unknown;
    confidence: number | null;
  };
  evaluated_at: string;
}

export interface ApplicantDocumentSummary {
  doc_type: string;
  verification_status: "Pending" | "Verified" | "Failed" | "Manual Review";
}

export type ApplicantStageLabel =
  | "Application Received"
  | "Under Screening"
  | "Eligibility Confirmed"
  | "Scored"
  | "Needs Review"
  | "Shortlisted"
  | "Verification In Progress"
  | "Verified"
  | "Rejected"
  | "Selected"
  | "Withdrawn";

export interface ApplicantStatusView {
  candidate_id: string;
  full_name: string;
  position_applied: string | null;
  job_circular_id: string | null;
  stage: ApplicantStageLabel;
  stage_pill: "green" | "amber" | "red" | "neutral";
  reasons: ApplicantReasonEntry[]; // filtered by org visibility config
  evidence_documents: ApplicantDocumentSummary[];
  estimated_timeline_text: string; // localized per org config
  next_expected_update: string; // deterministic, template-derived from stage + timeline text
  appeal_enabled: boolean;
  language: string;
  reason_code: string; // top-level: why this exact stage/pill was assigned (Global Reasoning Standard applies to the status result itself, not just failures)
  reason_description: string;
}
