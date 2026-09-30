/**
 * Quest 05 Part 9 — Reason code translation layer.
 * Maps every reason_code emitted by the backend to plain-language sentences.
 *
 * Sources:
 *   - src/rules/engine/evaluator.ts (MISSING_FIELD, OCR_LOW_CONFIDENCE, RULE_EXCEPTION, OK, BORDERLINE_*)
 *   - src/rules/engine/evaluator.ts applyHumanOverride (HUMAN_OVERRIDE)
 *   - src/ui/src/components/CandidateInspector.tsx REASON_EXPLANATIONS (legacy map)
 *   - src/agents/recruitment_analytics_agent (SOURCE_*)
 *   - src/agents/rediscovery_agent (REDISCOVERY_*)
 *   - src/agents/digital_exam_agent (EXAM_*)
 *   - src/agents/dimension_scoring_agent (DIMENSION_*)
 *   - BrainStudio default (MANUAL_REVIEW_REQUIRED)
 *   - Dynamic: rule.fail_reason_code (per-rule, user-defined)
 *
 * If a code is NOT in this map, the UI shows a fallback message and logs a warning.
 */

export interface ReasonCodeEntry {
  /** The machine-readable code (e.g., "OCR_LOW_CONFIDENCE") */
  code: string;
  /** Short label for badges (≤3 words) */
  short_label: string;
  /** Full sentence for detail views */
  full_sentence: string;
  /** "Why?" expansion — evidence format explanation */
  why: string;
  /** Visual tone for the badge */
  tone: "pass" | "review" | "human" | "fail";
}

/** Master map of all known reason codes */
export const REASON_CODES: Record<string, ReasonCodeEntry> = {
  // ─ Evaluator core ────────────────────────────────────────────────
  OK: {
    code: "OK",
    short_label: "Pass",
    full_sentence: "This candidate meets the requirement.",
    why: "The evaluated value satisfied the rule threshold.",
    tone: "pass",
  },
  MISSING_FIELD: {
    code: "MISSING_FIELD",
    short_label: "Missing data",
    full_sentence: "A required field was not found in the candidate's profile.",
    why: "The rule references a field path that has no value (null or undefined).",
    tone: "review",
  },
  OCR_LOW_CONFIDENCE: {
    code: "OCR_LOW_CONFIDENCE",
    short_label: "Low confidence",
    full_sentence: "The extracted data could not be read with enough certainty.",
    why: "OCR confidence score is below the rule's minimum threshold.",
    tone: "review",
  },
  RULE_EXCEPTION: {
    code: "RULE_EXCEPTION",
    short_label: "Rule error",
    full_sentence: "The rule could not be evaluated due to a technical error.",
    why: "An exception was thrown during rule evaluation (operator mismatch, type error, etc.).",
    tone: "review",
  },
  HUMAN_OVERRIDE: {
    code: "HUMAN_OVERRIDE",
    short_label: "Human override",
    full_sentence: "A human reviewer overrode the automated decision.",
    why: "A reviewer manually changed the evaluation outcome with a written justification.",
    tone: "human",
  },
  MANUAL_REVIEW_REQUIRED: {
    code: "MANUAL_REVIEW_REQUIRED",
    short_label: "Needs review",
    full_sentence: "This item requires manual review before a decision can be made.",
    why: "The rule is configured to flag this condition for human judgment.",
    tone: "review",
  },

  // ── Legacy explanations (from CandidateInspector REASON_EXPLANATIONS) ─
  LOW_CONFIDENCE: {
    code: "LOW_CONFIDENCE",
    short_label: "Low confidence",
    full_sentence: "The system could not extract data from the candidate's documents with enough certainty.",
    why: "Document parsing returned a confidence score below the acceptable threshold.",
    tone: "review",
  },
  MISSING_DOCUMENT: {
    code: "MISSING_DOCUMENT",
    short_label: "Missing document",
    full_sentence: "A required document (e.g. degree certificate, NID) was not provided.",
    why: "The candidate's file list does not include a document matching the required type.",
    tone: "fail",
  },
  EXPERIENCE_MISMATCH: {
    code: "EXPERIENCE_MISMATCH",
    short_label: "Experience gap",
    full_sentence: "The candidate's work experience does not meet the minimum required for this position.",
    why: "Years of experience extracted from the CV is less than the rule threshold.",
    tone: "fail",
  },
  EDUCATION_MISMATCH: {
    code: "EDUCATION_MISMATCH",
    short_label: "Education gap",
    full_sentence: "The candidate's educational qualification does not match the requirement.",
    why: "Degree level, field, or institution does not satisfy the rule criteria.",
    tone: "fail",
  },
  AGE_OUT_OF_RANGE: {
    code: "AGE_OUT_OF_RANGE",
    short_label: "Age mismatch",
    full_sentence: "The candidate's age falls outside the acceptable range for this circular.",
    why: "Calculated age from date of birth is below or above the rule's age band.",
    tone: "fail",
  },
  DUPLICATE_CANDIDATE: {
    code: "DUPLICATE_CANDIDATE",
    short_label: "Duplicate",
    full_sentence: "This candidate appears to have applied more than once.",
    why: "Matching name, phone, or email found against an existing candidate record.",
    tone: "review",
  },
  FRAUD_SUSPECTED: {
    code: "FRAUD_SUSPECTED",
    short_label: "Fraud alert",
    full_sentence: "Automated checks detected inconsistencies in the submitted documents.",
    why: "Document metadata, image analysis, or cross-reference checks flagged anomalies.",
    tone: "fail",
  },
  SCORE_BELOW_THRESHOLD: {
    code: "SCORE_BELOW_THRESHOLD",
    short_label: "Below threshold",
    full_sentence: "The candidate's composite score is below the shortlisting threshold.",
    why: "Weighted score across all dimensions did not reach the minimum passing score.",
    tone: "fail",
  },
  MANUAL_OVERRIDE: {
    code: "MANUAL_OVERRIDE",
    short_label: "Overridden",
    full_sentence: "A human operator overrode the system's automated decision.",
    why: "Same as HUMAN_OVERRIDE — legacy code kept for backward compatibility.",
    tone: "human",
  },
  VERIFICATION_FAILED: {
    code: "VERIFICATION_FAILED",
    short_label: "Verification failed",
    full_sentence: "External verification (e.g. university, employer) returned a negative result.",
    why: "Third-party API or manual verification confirmed the data does not match.",
    tone: "fail",
  },

  // ── Recruitment analytics ──────────────────────────────────────────
  SOURCE_PASS_RATE_BELOW_THRESHOLD: {
    code: "SOURCE_PASS_RATE_BELOW_THRESHOLD",
    short_label: "Low pass rate",
    full_sentence: "Candidates from this source have a pass rate below the acceptable threshold.",
    why: "The ratio of candidates who pass evaluation from this source is too low.",
    tone: "review",
  },
  SOURCE_SELECTION_RATE_BELOW_THRESHOLD: {
    code: "SOURCE_SELECTION_RATE_BELOW_THRESHOLD",
    short_label: "Low selection rate",
    full_sentence: "Candidates from this source are selected at a rate below the acceptable threshold.",
    why: "The ratio of candidates who are ultimately selected from this source is too low.",
    tone: "review",
  },
  SOURCE_EFFECTIVENESS_COMPUTED: {
    code: "SOURCE_EFFECTIVENESS_COMPUTED",
    short_label: "Analytics computed",
    full_sentence: "Source effectiveness metrics have been computed for this channel.",
    why: "The analytics agent completed its evaluation of sourcing channel performance.",
    tone: "pass",
  },
  FUNNEL_COMPUTED: {
    code: "FUNNEL_COMPUTED",
    short_label: "Funnel computed",
    full_sentence: "The recruitment funnel metrics have been computed.",
    why: "Stage-by-stage conversion rates have been calculated for the reporting period.",
    tone: "pass",
  },
  QUALITY_HIRE_COST_COMPUTED: {
    code: "QUALITY_HIRE_COST_COMPUTED",
    short_label: "Cost computed",
    full_sentence: "The cost per quality hire metric has been computed.",
    why: "Total spend divided by quality hires has been calculated for this source.",
    tone: "pass",
  },
  SOURCE_COST_PER_QUALITY_HIRE_ABOVE_THRESHOLD: {
    code: "SOURCE_COST_PER_QUALITY_HIRE_ABOVE_THRESHOLD",
    short_label: "High cost/hire",
    full_sentence: "The cost per quality hire from this source exceeds the acceptable threshold.",
    why: "Total spend divided by quality hires is above the configured budget limit.",
    tone: "review",
  },
  SOURCE_ZERO_QUALITY_HIRES_WITH_SPEND: {
    code: "SOURCE_ZERO_QUALITY_HIRES_WITH_SPEND",
    short_label: "No quality hires",
    full_sentence: "This sourcing channel has spend but produced zero quality hires.",
    why: "Total spend > 0 but quality_hire_count = 0 for the reporting period.",
    tone: "fail",
  },

  // ── Rediscovery ───────────────────────────────────────────────────
  REDISCOVERY_OPTED_IN: {
    code: "REDISCOVERY_OPTED_IN",
    short_label: "Opted in",
    full_sentence: "This candidate has opted in to rediscovery for new opportunities.",
    why: "The candidate previously consented to be re-contacted for suitable positions.",
    tone: "pass",
  },
  REDISCOVERY_MATCH_SUGGESTED: {
    code: "REDISCOVERY_MATCH_SUGGESTED",
    short_label: "Rediscovery match",
    full_sentence: "The rediscovery agent suggests re-engaging this candidate for the current opening.",
    why: "The candidate's profile matches the current job requirements based on past data.",
    tone: "review",
  },
  REDISCOVERY_ITEM_ERROR: {
    code: "REDISCOVERY_ITEM_ERROR",
    short_label: "Rediscovery error",
    full_sentence: "An error occurred while processing this rediscovery suggestion.",
    why: "The rediscovery agent encountered a technical issue with this item.",
    tone: "fail",
  },
  REDISCOVERY_OUTREACH_SENT_BY_HUMAN: {
    code: "REDISCOVERY_OUTREACH_SENT_BY_HUMAN",
    short_label: "Outreach sent",
    full_sentence: "A human operator sent a re-engagement message to this candidate.",
    why: "After review, an operator manually initiated contact with the candidate.",
    tone: "human",
  },
  REDISCOVERY_SUGGESTION_APPROVED_BY_HUMAN: {
    code: "REDISCOVERY_SUGGESTION_APPROVED_BY_HUMAN",
    short_label: "Rediscovery approved",
    full_sentence: "A human reviewer approved the rediscovery suggestion to re-engage this candidate.",
    why: "The rediscovery agent flagged a past candidate as potentially suitable; a reviewer confirmed.",
    tone: "pass",
  },
  REDISCOVERY_SUGGESTION_REJECTED_BY_HUMAN: {
    code: "REDISCOVERY_SUGGESTION_REJECTED_BY_HUMAN",
    short_label: "Rediscovery rejected",
    full_sentence: "A human reviewer rejected the rediscovery suggestion.",
    why: "The rediscovery agent's suggestion was reviewed and dismissed by a human operator.",
    tone: "human",
  },

  // ── Dimension scoring ──────────────────────────────────────────────
  KNOCKOUT: {
    code: "KNOCKOUT",
    short_label: "Knockout",
    full_sentence: "This candidate was eliminated by a knockout criterion.",
    why: "A mandatory requirement was not met, ending further evaluation.",
    tone: "fail",
  },
  DIMENSION_MISMATCH: {
    code: "DIMENSION_MISMATCH",
    short_label: "Dimension gap",
    full_sentence: "The candidate's score on this dimension does not meet the requirement.",
    why: "Dimension score is below the configured threshold for this role.",
    tone: "fail",
  },
  DIMENSION_PASS: {
    code: "DIMENSION_PASS",
    short_label: "Dimension pass",
    full_sentence: "The candidate meets the requirement on this dimension.",
    why: "Dimension score meets or exceeds the threshold.",
    tone: "pass",
  },

  // ── Digital exam ───────────────────────────────────────────────────
  MCQ_CORRECT_MATCH: {
    code: "MCQ_CORRECT_MATCH",
    short_label: "MCQ correct",
    full_sentence: "The candidate answered this multiple-choice question correctly.",
    why: "The selected answer matches the expected correct answer.",
    tone: "pass",
  },
  MCQ_WRONG_ANSWER: {
    code: "MCQ_WRONG_ANSWER",
    short_label: "MCQ wrong",
    full_sentence: "The candidate answered this multiple-choice question incorrectly.",
    why: "The selected answer does not match the expected correct answer.",
    tone: "fail",
  },
  MCQ_SKIPPED_NO_ANSWER: {
    code: "MCQ_SKIPPED_NO_ANSWER",
    short_label: "MCQ skipped",
    full_sentence: "The candidate did not answer this question.",
    why: "No answer was provided for this question.",
    tone: "review",
  },
  SHORT_ANSWER_PENDING_MANUAL_GRADE: {
    code: "SHORT_ANSWER_PENDING_MANUAL_GRADE",
    short_label: "Pending grading",
    full_sentence: "This short-answer response requires manual grading by a reviewer.",
    why: "Automated grading could not evaluate the text response with sufficient confidence.",
    tone: "review",
  },
  SHORT_ANSWER_MANUALLY_GRADED: {
    code: "SHORT_ANSWER_MANUALLY_GRADED",
    short_label: "Manually graded",
    full_sentence: "A human reviewer has graded this short-answer response.",
    why: "A reviewer evaluated the text response and assigned marks.",
    tone: "pass",
  },
  EXAM_SCORE_BELOW_PASS: {
    code: "EXAM_SCORE_BELOW_PASS",
    short_label: "Exam failed",
    full_sentence: "The candidate's exam score is below the passing threshold.",
    why: "Total exam score did not reach the minimum passing score configured for this exam.",
    tone: "fail",
  },
  EXAM_NEEDS_REVIEW: {
    code: "EXAM_NEEDS_REVIEW",
    short_label: "Exam review",
    full_sentence: "The exam submission requires manual review before scoring.",
    why: "The exam agent flagged the submission for human grading (e.g. essay question).",
    tone: "review",
  },
  EXAM_PASSED: {
    code: "EXAM_PASSED",
    short_label: "Exam passed",
    full_sentence: "The candidate passed the digital exam.",
    why: "Exam score meets or exceeds the passing threshold.",
    tone: "pass",
  },

  // ── Reference checks ───────────────────────────────────────────────
  REFERENCE_RATING_SCORED: {
    code: "REFERENCE_RATING_SCORED",
    short_label: "Reference scored",
    full_sentence: "This reference check has been scored.",
    why: "The referee provided a rating that was converted into a numerical score.",
    tone: "pass",
  },
  REFERENCE_RATING_INVALID: {
    code: "REFERENCE_RATING_INVALID",
    short_label: "Invalid rating",
    full_sentence: "The reference rating provided is not valid.",
    why: "The rating value falls outside the expected scale or format.",
    tone: "review",
  },
  REFERENCE_REQUEST_SENT: {
    code: "REFERENCE_REQUEST_SENT",
    short_label: "Request sent",
    full_sentence: "A reference request has been sent to the referee.",
    why: "The system dispatched a reference check request via the configured channel.",
    tone: "pass",
  },
  REFERENCE_RESPONSE_RECEIVED: {
    code: "REFERENCE_RESPONSE_RECEIVED",
    short_label: "Response received",
    full_sentence: "A response has been received for this reference check.",
    why: "The referee submitted their evaluation.",
    tone: "pass",
  },
  REFERENCE_RESPONSE_MISSING: {
    code: "REFERENCE_RESPONSE_MISSING",
    short_label: "No response",
    full_sentence: "No response has been received for this reference check.",
    why: "The reference request was sent but no reply has arrived within the expected timeframe.",
    tone: "review",
  },

  // ── Eligibility / application ──────────────────────────────────────
  DUPLICATE_APPLICATION: {
    code: "DUPLICATE_APPLICATION",
    short_label: "Duplicate application",
    full_sentence: "This candidate has already applied for this position.",
    why: "A matching application record was found for the same candidate and job circular.",
    tone: "review",
  },
  SHORTLIST_REJECTED: {
    code: "SHORTLIST_REJECTED",
    short_label: "Not shortlisted",
    full_sentence: "The candidate was not selected for the shortlist.",
    why: "The candidate's overall score or ranking did not meet the shortlisting criteria.",
    tone: "fail",
  },
  DUPLICATE_NATIONAL_ID: {
    code: "DUPLICATE_NATIONAL_ID",
    short_label: "Duplicate ID",
    full_sentence: "The national ID number matches an existing candidate record.",
    why: "Fraud detection found the same national ID already associated with another application.",
    tone: "fail",
  },

  // ── Auth / audit events ────────────────────────────────────────────
  LOGIN: { code: "LOGIN", short_label: "Signed in", full_sentence: "A user signed in to the system.", why: "Authentication succeeded with valid credentials.", tone: "pass" },
  LOGOUT: { code: "LOGOUT", short_label: "Signed out", full_sentence: "A user signed out of the system.", why: "The session was terminated by the user.", tone: "pass" },
  LOGOUT_ALL: { code: "LOGOUT_ALL", short_label: "All sessions ended", full_sentence: "All active sessions for this user have been terminated.", why: "A global logout was triggered, invalidating all session tokens.", tone: "pass" },
  ORG_SWITCH: { code: "ORG_SWITCH", short_label: "Org switched", full_sentence: "The user switched to a different organization.", why: "The active organization context was changed.", tone: "pass" },
  INVITE: { code: "INVITE", short_label: "Invited", full_sentence: "An invitation was sent to a new user.", why: "A user account was created and an invite email dispatched.", tone: "pass" },
  ADMIN_REVOKED: { code: "ADMIN_REVOKED", short_label: "Admin revoked", full_sentence: "An administrator revoked this user's access.", why: "An admin manually disabled the user account.", tone: "fail" },
  SESSION_LIMIT: { code: "SESSION_LIMIT", short_label: "Session limit", full_sentence: "The maximum number of concurrent sessions was reached.", why: "The user already has the maximum allowed active sessions.", tone: "review" },
  TOKEN_REUSED: { code: "TOKEN_REUSED", short_label: "Token reused", full_sentence: "A previously used authentication token was presented again.", why: "Token reuse may indicate theft or a replay attack.", tone: "fail" },
  BAD_CREDENTIALS: { code: "BAD_CREDENTIALS", short_label: "Bad credentials", full_sentence: "The provided credentials are incorrect.", why: "Email or password did not match any account.", tone: "fail" },
  BAD_CURRENT_PASSWORD: { code: "BAD_CURRENT_PASSWORD", short_label: "Wrong password", full_sentence: "The current password entered is incorrect.", why: "The user provided the wrong current password during a password change.", tone: "fail" },
  PASSWORD_CHANGE: { code: "PASSWORD_CHANGE", short_label: "Password changed", full_sentence: "The user changed their password.", why: "A password update was successfully applied.", tone: "pass" },
  PASSWORD_RESET_REQUIRED: { code: "PASSWORD_RESET_REQUIRED", short_label: "Reset required", full_sentence: "A password reset is required before continuing.", why: "The account policy requires the user to set a new password.", tone: "review" },
  RESET_REQUESTED: { code: "RESET_REQUESTED", short_label: "Reset requested", full_sentence: "A password reset was requested.", why: "The user initiated the password recovery flow.", tone: "pass" },
  RESET_LINK_ISSUED: { code: "RESET_LINK_ISSUED", short_label: "Reset link sent", full_sentence: "A password reset link has been sent.", why: "A one-time reset link was dispatched to the user's email.", tone: "pass" },
  RESET_COMPLETED: { code: "RESET_COMPLETED", short_label: "Reset done", full_sentence: "The password has been successfully reset.", why: "The user completed the password reset flow.", tone: "pass" },
  UNKNOWN_EMAIL: { code: "UNKNOWN_EMAIL", short_label: "Unknown email", full_sentence: "No account was found with this email address.", why: "The email address does not match any registered user.", tone: "review" },
  UNKNOWN_OR_INACTIVE_ACCOUNT: { code: "UNKNOWN_OR_INACTIVE_ACCOUNT", short_label: "Unknown account", full_sentence: "The account is unknown or inactive.", why: "No active account matches the provided identifier.", tone: "review" },
  DELIVERY_FAILED: { code: "DELIVERY_FAILED", short_label: "Delivery failed", full_sentence: "Message delivery failed.", why: "The email or notification could not be delivered.", tone: "fail" },
  EMAIL_SEND_ERROR: { code: "EMAIL_SEND_ERROR", short_label: "Email error", full_sentence: "An error occurred while sending the email.", why: "The email service returned an error during delivery.", tone: "fail" },
  CONFIG_UPDATED: { code: "CONFIG_UPDATED", short_label: "Config updated", full_sentence: "A configuration setting was updated.", why: "An administrator changed a system configuration value.", tone: "pass" },
  GRACEFUL_SHUTDOWN: { code: "GRACEFUL_SHUTDOWN", short_label: "Shutdown", full_sentence: "The service shut down gracefully.", why: "A controlled shutdown was completed, draining active requests.", tone: "pass" },
  FENCING_TOKEN_MISMATCH: { code: "FENCING_TOKEN_MISMATCH", short_label: "Token mismatch", full_sentence: "A fencing token mismatch was detected.", why: "A concurrent operation used a stale fencing token, indicating a race condition.", tone: "fail" },

  // ── Agent infrastructure ───────────────────────────────────────────
  AGENT_OK: { code: "AGENT_OK", short_label: "Agent OK", full_sentence: "The agent completed its task successfully.", why: "The agent runtime reports successful execution.", tone: "pass" },
  AGENT_ERROR: { code: "AGENT_ERROR", short_label: "Agent error", full_sentence: "The agent encountered an error.", why: "An unhandled error occurred during agent execution.", tone: "fail" },
  AGENT_ITEM_ERROR: { code: "AGENT_ITEM_ERROR", short_label: "Item error", full_sentence: "An error occurred while processing this item.", why: "The agent failed on a specific candidate or record.", tone: "fail" },
  AGENT_BATCH_COMPLETED: { code: "AGENT_BATCH_COMPLETED", short_label: "Batch done", full_sentence: "The processing batch has completed.", why: "All items in the batch have been processed.", tone: "pass" },
  AGENT_BATCH_RESUMED: { code: "AGENT_BATCH_RESUMED", short_label: "Batch resumed", full_sentence: "The processing batch was resumed after interruption.", why: "A previously interrupted batch was restarted from its checkpoint.", tone: "pass" },
  AGENT_CIRCUIT_OPEN: { code: "AGENT_CIRCUIT_OPEN", short_label: "Circuit open", full_sentence: "The agent's circuit breaker is open.", why: "Too many failures caused the circuit breaker to trip, pausing further calls.", tone: "fail" },
  SUPERVISOR_RESTART: { code: "SUPERVISOR_RESTART", short_label: "Supervisor restart", full_sentence: "The supervisor restarted an agent.", why: "The supervisor detected a failed agent and initiated a restart.", tone: "review" },
  SUPERVISOR_RESTARTS_EXHAUSTED: { code: "SUPERVISOR_RESTARTS_EXHAUSTED", short_label: "Restarts exhausted", full_sentence: "The supervisor has exhausted all restart attempts.", why: "The agent failed repeatedly and no more retries are allowed.", tone: "fail" },
  PROCESS_UNSTABLE: { code: "PROCESS_UNSTABLE", short_label: "Unstable", full_sentence: "The agent process is unstable.", why: "Repeated crashes or health check failures indicate process instability.", tone: "fail" },

  // ── Communication ──────────────────────────────────────────────────
  CONTACT_CHANNEL_MISSING: { code: "CONTACT_CHANNEL_MISSING", short_label: "No channel", full_sentence: "No contact channel is available for this candidate.", why: "The candidate record has no email or phone number for communication.", tone: "review" },
  DISPATCH_SUCCESS: { code: "DISPATCH_SUCCESS", short_label: "Dispatched", full_sentence: "The communication was dispatched successfully.", why: "A message was sent via the configured channel.", tone: "pass" },
  TEMPLATE_LANGUAGE_MATCHED_CANDIDATE: { code: "TEMPLATE_LANGUAGE_MATCHED_CANDIDATE", short_label: "Lang matched", full_sentence: "The template language matched the candidate's preference.", why: "The communication template was selected based on the candidate's language.", tone: "pass" },
  TEMPLATE_LANGUAGE_FALLBACK_TO_ORG_DEFAULT: { code: "TEMPLATE_LANGUAGE_FALLBACK_TO_ORG_DEFAULT", short_label: "Lang fallback", full_sentence: "The template fell back to the organization's default language.", why: "No template matched the candidate's language; the org default was used.", tone: "review" },
  TEMPLATE_LANGUAGE_FALLBACK_TO_EN: { code: "TEMPLATE_LANGUAGE_FALLBACK_TO_EN", short_label: "English fallback", full_sentence: "The template fell back to English.", why: "No template matched the candidate's language or the org default; English was used.", tone: "review" },

  // ── Offboarding ────────────────────────────────────────────────────
  OFFBOARDING_CASE_STARTED: { code: "OFFBOARDING_CASE_STARTED", short_label: "Case started", full_sentence: "An offboarding case has been started.", why: "The offboarding process was initiated for this individual.", tone: "pass" },
  OFFBOARDING_CASE_COMPLETED: { code: "OFFBOARDING_CASE_COMPLETED", short_label: "Case done", full_sentence: "The offboarding case has been completed.", why: "All offboarding steps have been fulfilled.", tone: "pass" },
  OFFBOARDING_TEMPLATE_CREATED: { code: "OFFBOARDING_TEMPLATE_CREATED", short_label: "Template created", full_sentence: "An offboarding template was created.", why: "A new offboarding workflow template was defined.", tone: "pass" },
  OFFBOARDING_TEMPLATE_UPDATED: { code: "OFFBOARDING_TEMPLATE_UPDATED", short_label: "Template updated", full_sentence: "An offboarding template was updated.", why: "An existing offboarding template was modified.", tone: "pass" },
  STEP_COMPLETED_BY_ASSIGNEE: { code: "STEP_COMPLETED_BY_ASSIGNEE", short_label: "Step done", full_sentence: "An offboarding step was completed by the assignee.", why: "The person responsible marked this step as done.", tone: "pass" },
  STEP_FLAGGED_OVERDUE: { code: "STEP_FLAGGED_OVERDUE", short_label: "Overdue", full_sentence: "An offboarding step has been flagged as overdue.", why: "The step's due date has passed without completion.", tone: "fail" },
  STEP_DUE_REMINDER_SENT: { code: "STEP_DUE_REMINDER_SENT", short_label: "Reminder sent", full_sentence: "A reminder was sent for an upcoming offboarding step.", why: "An automated reminder was dispatched before the step's due date.", tone: "pass" },

  // ── Applicant portal ───────────────────────────────────────────────
  OTP_ISSUED: { code: "OTP_ISSUED", short_label: "OTP sent", full_sentence: "A one-time password was issued.", why: "An OTP was generated and sent to the applicant.", tone: "pass" },
  OTP_NOT_FOUND: { code: "OTP_NOT_FOUND", short_label: "OTP not found", full_sentence: "The one-time password was not found.", why: "No matching OTP record exists for the provided code.", tone: "fail" },
  OTP_EXPIRED: { code: "OTP_EXPIRED", short_label: "OTP expired", full_sentence: "The one-time password has expired.", why: "The OTP was not used within its validity window.", tone: "fail" },
  OTP_MAX_ATTEMPTS_EXCEEDED: { code: "OTP_MAX_ATTEMPTS_EXCEEDED", short_label: "Max attempts", full_sentence: "The maximum number of OTP attempts has been exceeded.", why: "Too many incorrect OTP entries were attempted.", tone: "fail" },
  OTP_MISMATCH: { code: "OTP_MISMATCH", short_label: "OTP mismatch", full_sentence: "The one-time password does not match.", why: "The entered OTP does not match the issued value.", tone: "fail" },
  OTP_VERIFIED: { code: "OTP_VERIFIED", short_label: "OTP verified", full_sentence: "The one-time password was verified successfully.", why: "The applicant provided the correct OTP.", tone: "pass" },
  STATUS_VIEW_SERVED: { code: "STATUS_VIEW_SERVED", short_label: "Status viewed", full_sentence: "The applicant's status view was served.", why: "The applicant portal rendered the current application status.", tone: "pass" },

  // ── Reference checks (additional) ─────────────────────────────────
  REFERENCE_REQUEST_CREATED: { code: "REFERENCE_REQUEST_CREATED", short_label: "Ref request created", full_sentence: "A reference check request was created.", why: "The system created a new reference request for this candidate.", tone: "pass" },
  REFERENCE_REQUEST_SEND_FAILED: { code: "REFERENCE_REQUEST_SEND_FAILED", short_label: "Ref send failed", full_sentence: "Failed to send the reference check request.", why: "The reference request could not be delivered to the referee.", tone: "fail" },
  REFERENCE_TEXT_EVIDENCE_ONLY: { code: "REFERENCE_TEXT_EVIDENCE_ONLY", short_label: "Text only", full_sentence: "The reference response contains text evidence only.", why: "The referee provided narrative feedback without structured ratings.", tone: "review" },
  REFERENCE_YESNO_INVALID: { code: "REFERENCE_YESNO_INVALID", short_label: "Invalid Y/N", full_sentence: "The yes/no reference response is invalid.", why: "The referee provided an unexpected value for a yes/no question.", tone: "review" },
  REFERENCE_YESNO_SCORED: { code: "REFERENCE_YESNO_SCORED", short_label: "Y/N scored", full_sentence: "The yes/no reference response has been scored.", why: "A yes/no answer was converted to a numerical score.", tone: "pass" },

  // ── Rediscovery (additional) ───────────────────────────────────────
  REDISCOVERY_RUN_COMPLETED: { code: "REDISCOVERY_RUN_COMPLETED", short_label: "Run done", full_sentence: "A rediscovery matching run has completed.", why: "The rediscovery agent finished scanning past candidates.", tone: "pass" },

  // ── Reports ────────────────────────────────────────────────────────
  REPORT_GENERATED: { code: "REPORT_GENERATED", short_label: "Report generated", full_sentence: "A report has been generated.", why: "The report agent compiled and exported the requested report.", tone: "pass" },

  // ── Pipeline decisions ─────────────────────────────────────────────
  COMMUNICATION_REJECTED: { code: "COMMUNICATION_REJECTED", short_label: "Comm rejected", full_sentence: "The communication was rejected by a reviewer.", why: "A human reviewer decided not to send the proposed communication.", tone: "human" },
  FINAL_APPROVAL_REJECTED: { code: "FINAL_APPROVAL_REJECTED", short_label: "Approval rejected", full_sentence: "Final approval was rejected.", why: "A senior reviewer rejected the candidate at the final approval stage.", tone: "human" },
  EXAM_PUBLISHED_HUMAN_APPROVAL: { code: "EXAM_PUBLISHED_HUMAN_APPROVAL", short_label: "Exam published", full_sentence: "The exam was published after human approval.", why: "A human reviewer approved the exam for publication.", tone: "human" },

  // ── Borderline (dynamic — matched by prefix) ───────────────────────
  // BORDERLINE_* codes are generated at runtime. The prefix handler below
  // catches any code starting with "BORDERLINE_".
};

/**
 * Look up a reason code. Returns the entry if found.
 * For BORDERLINE_* codes, returns a generated entry.
 * For unknown codes, returns null (caller shows fallback).
 */
export function lookupReasonCode(code: string | null | undefined): ReasonCodeEntry | null {
  if (!code) return null;

  // Direct match
  if (REASON_CODES[code]) return REASON_CODES[code];

  // BORDERLINE_* prefix match
  if (code.startsWith("BORDERLINE_")) {
    const ruleCode = code.replace("BORDERLINE_", "");
    return {
      code,
      short_label: "Borderline",
      full_sentence: `The candidate's score is very close to the threshold for rule "${ruleCode}".`,
      why: `The value fell within the review margin of the rule threshold. Manual judgment recommended.`,
      tone: "review",
    };
  }

  // INELIGIBLE prefix
  if (code.includes("INELIGIBLE")) {
    return {
      code,
      short_label: "Ineligible",
      full_sentence: "The candidate does not meet the eligibility criteria.",
      why: `Reason code "${code}" indicates an eligibility failure.`,
      tone: "fail",
    };
  }

  // FAIL prefix
  if (code.includes("FAIL")) {
    return {
      code,
      short_label: "Failed",
      full_sentence: "The candidate did not pass this check.",
      why: `Reason code "${code}" indicates a failure condition.`,
      tone: "fail",
    };
  }

  // Unknown — return null so caller shows fallback
  console.warn(`[reasonCodes] Unknown reason code: "${code}" — showing fallback`);
  return null;
}

/** Get the tone color class for a reason code */
export function getReasonToneClass(tone: ReasonCodeEntry["tone"]): string {
  switch (tone) {
    case "pass":
      return "bg-success/10 text-success";
    case "review":
      return "bg-attention/10 text-attention";
    case "human":
      return "bg-human/10 text-human";
    case "fail":
      return "bg-danger/10 text-danger";
  }
}

/** Get all known codes (for CI coverage check) */
export function getAllKnownCodes(): string[] {
  return Object.keys(REASON_CODES);
}
