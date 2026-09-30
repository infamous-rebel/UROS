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
