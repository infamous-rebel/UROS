// Feature 10: Candidate Rediscovery / Talent Pool Re-engagement — types.
//
// UROS_Global_Reasoning_Standard.md: every suggestion carries a
// reason_code, reason_description, and evidence. The agent only ever
// suggests (status starts PENDING_REVIEW); APPROVED/REJECTED is set
// exclusively by a human via PATCH /api/v1/rediscovery/suggestions/:id,
// and outreach is only ever sent for an APPROVED suggestion via a
// separate, explicitly human-triggered POST /api/v1/rediscovery/outreach
// call (Core Principle: Human-in-the-Loop — never auto-invite).

export type RediscoveryConsentStatus = "OPTED_IN" | "OPTED_OUT" | "NO_RECORD";

export interface RediscoveryConsent {
  consent_id: string;
  candidate_id: string;
  org_id: string;
  opted_in: boolean;
  opted_in_at: string | null;
  opted_out_at: string | null;
  updated_at: string;
}

export type RediscoverySuggestionStatus = "PENDING_REVIEW" | "APPROVED" | "REJECTED";

export interface RediscoveryEvidence {
  fit_score: number;
  breakdown: Record<string, number>;
  matched: string[];
  unmatched: string[];
  persona_id: string;
  target_circular_id: string;
  target_position: string | null;
  previous_status: string;
  previous_job_circular_id: string | null;
  previous_position_applied: string | null;
  consent_status: RediscoveryConsentStatus;
  exclusion_checks: {
    fraud_flag_free: boolean;
    cooldown_days: number;
    days_since_last_update: number;
    not_previously_suggested_for_circular: boolean;
    require_opt_in: boolean;
  };
}

export interface RediscoverySuggestion {
  suggestion_id: string;
  org_id: string;
  candidate_id: string;
  target_circular_id: string;
  target_position: string | null;
  fit_score: number;
  reason_code: string;
  reason_description: string;
  evidence: RediscoveryEvidence;
  status: RediscoverySuggestionStatus;
  created_at: string;
  reviewed_by: string | null;
  reviewed_at: string | null;
  review_reason: string | null;
}

export type RediscoveryOutreachChannel = "SMS" | "EMAIL" | "WHATSAPP";
export type RediscoveryOutreachStatus = "SENT" | "FAILED";
export type RediscoveryResponseStatus = "PENDING" | "INTERESTED" | "NOT_INTERESTED" | "NO_RESPONSE";

export interface RediscoveryOutreach {
  outreach_id: string;
  suggestion_id: string;
  channel: RediscoveryOutreachChannel;
  template_code: string;
  status: RediscoveryOutreachStatus;
  sent_at: string;
  response_status: RediscoveryResponseStatus;
  responded_at: string | null;
}

/** Deterministic run parameters for POST /api/v1/rediscovery/run. Every default is explicit and org-overridable per run — no hidden policy. */
export interface RediscoveryRunParams {
  target_circular_id: string;
  target_position: string | null;
  persona_id: string;
  /** Minimum overall_fit_score (0-100) required to create a suggestion. Default 50. */
  min_fit_score: number;
  /** A candidate whose record was last updated (rejected/withdrawn) more recently than this many days ago is excluded — avoids re-approaching someone too soon. Default 90. */
  min_days_since_decision: number;
  /** When true (default), only candidates with an explicit opted_in=true consent row are considered. When false, candidates with no consent record are still considered (org policy decision made explicitly at run time by the requesting ADMIN/SENIOR_RECRUITER) — an explicit opt-out is always excluded regardless of this flag. */
  require_opt_in: boolean;
  /** Caps how many eligible candidates are scored in one run. Default 200. */
  max_candidates: number;
}

export interface RediscoveryRunResult {
  target_circular_id: string;
  persona_id: string;
  candidates_considered: number;
  candidates_excluded_recent: number;
  candidates_excluded_fraud: number;
  candidates_excluded_consent: number;
  candidates_excluded_already_suggested: number;
  candidates_below_threshold: number;
  suggestions_created: RediscoverySuggestion[];
}
