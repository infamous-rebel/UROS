import { createHash, randomInt } from "crypto";
import jwt from "jsonwebtoken";
import { db } from "../../database/client";
import { env } from "../../config/env.schema";
import { logAudit } from "../../utils/audit_helper";
import {
  ApplicantPortalConfig,
  ApplicantReasonEntry,
  ApplicantStageLabel,
  ApplicantStatusView,
  OtpChannel,
} from "../../models/applicant_portal.model";

// ---------------------------------------------------------------------
// OTP authentication — scoped strictly to the requesting candidate_id.
// The plaintext code is never persisted or logged; only a salted hash
// is stored, and only the fact that a code was requested/verified is
// audited. Delivery reuses the existing Communication Hub's
// communication_log table exactly like communication_agent.sendBatch
// does — no new send mechanism, no external AI/service dependency.
// ---------------------------------------------------------------------

const OTP_PEPPER = () => env.JWT_SECRET; // server-side secret; never stored alongside the hash

function hashOtp(code: string, candidateId: string): string {
  return createHash("sha256").update(`${candidateId}:${code}:${OTP_PEPPER()}`).digest("hex");
}

function generateOtp(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, "0");
}

/**
 * Feature 5: Multi-Language Interface and Document Support.
 *
 * Sets the authenticated applicant's own communication-language
 * preference (candidates.preferred_language), which the Communication
 * Hub's template-language resolver reads before falling back to the
 * organization default (see
 * src/services/communication/template_language_resolver.ts). Scoped to
 * the applicant's own org_id, matching every other portal query.
 */
export async function updateApplicantPreferredLanguage(
  candidateId: string,
  orgId: string,
  preferredLanguage: "en" | "bn"
): Promise<{ candidate_id: string; preferred_language: string }> {
  const result = await db.query<{ candidate_id: string; preferred_language: string | null }>(
    `UPDATE candidates SET preferred_language=$1, updated_at=now()
     WHERE candidate_id=$2 AND org_id=$3
     RETURNING candidate_id, preferred_language`,
    [preferredLanguage, candidateId, orgId]
  );

  if (result.rowCount === 0) {
    throw new Error("Candidate not found for this application");
  }

  await logAudit({
    entity_type: "CANDIDATE",
    entity_id: candidateId,
    agent_or_user: candidateId,
    action: "APPLICANT_LANGUAGE_PREFERENCE_UPDATED",
    output_value: { preferred_language: preferredLanguage },
  });

  return result.rows[0] as { candidate_id: string; preferred_language: string };
}

export interface OtpRequestResult {
  requested: boolean; // always true in the response to avoid candidate-ID enumeration
}

/**
 * Requests an OTP for a candidate to access their own status. Always
 * responds as if successful (requested: true) regardless of whether the
 * candidate_id exists, so the portal never confirms/denies a specific
 * application ID to an unauthenticated caller. If the candidate does
 * exist, a 6-digit code is generated, hashed, stored with an expiry, and
 * "delivered" via the Communication Hub.
 */
export async function requestApplicantOtp(candidateId: string, channel: OtpChannel): Promise<OtpRequestResult> {
  const candidateRes = await db.query(`SELECT candidate_id, org_id, email, phone_primary FROM candidates WHERE candidate_id=$1`, [candidateId]);
  if (candidateRes.rowCount === 0) {
    // Deliberately silent — do not reveal whether this ID exists.
    return { requested: true };
  }
  const candidateOrgId = candidateRes.rows[0].org_id as string;

  const code = generateOtp();
  const codeHash = hashOtp(code, candidateId);
  const expiresAt = new Date(Date.now() + env.APPLICANT_OTP_EXPIRY_MINUTES * 60_000);

  await db.query(
    `INSERT INTO applicant_otp_requests (candidate_id, channel, code_hash, expires_at) VALUES ($1,$2,$3,$4)`,
    [candidateId, channel, codeHash, expiresAt.toISOString()]
  );

  // Reuses the existing Communication Hub's log table — same mechanism
  // communication_agent.sendBatch uses. The code itself is intentionally
  // never written to communication_log or the audit trail.
  await db.query(
    `INSERT INTO communication_log (candidate_id, org_id, channel, template_code, status) VALUES ($1,$2,$3,'APPLICANT_PORTAL_OTP','SENT')`,
    [candidateId, candidateOrgId, channel]
  );

  await logAudit({
    org_id: candidateOrgId,
    entity_type: "APPLICANT_PORTAL",
    entity_id: candidateId,
    agent_or_user: "SYSTEM",
    action: "APPLICANT_OTP_REQUESTED",
    reason_code: "OTP_ISSUED",
    reason_comment: `A one-time login code was issued via ${channel}, expiring in ${env.APPLICANT_OTP_EXPIRY_MINUTES} minute(s).`,
    output_value: { channel },
  });

  return { requested: true };
}

export interface OtpVerifyResult {
  token: string;
  candidate_id: string;
  org_id: string;
}

export class OtpVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OtpVerificationError";
  }
}

/**
 * Verifies an OTP and, on success, issues a standard UROS JWT scoped to
 * role=APPLICANT and user_id=candidate_id — no new auth mechanism, this
 * reuses the exact same `authenticate`/`rbac` middleware every other
 * route already uses. Attempts are capped (max_attempts) and every
 * outcome is audited without ever logging the code itself.
 */
export async function verifyApplicantOtp(candidateId: string, code: string): Promise<OtpVerifyResult> {
  const otpRes = await db.query(
    `SELECT * FROM applicant_otp_requests WHERE candidate_id=$1 AND consumed_at IS NULL ORDER BY created_at DESC LIMIT 1`,
    [candidateId]
  );

  if (otpRes.rowCount === 0) {
    await logAudit({
      entity_type: "APPLICANT_PORTAL",
      entity_id: candidateId,
      agent_or_user: "SYSTEM",
      action: "APPLICANT_OTP_VERIFY_FAILED",
      reason_code: "OTP_NOT_FOUND",
      reason_comment: "No pending OTP request found for this candidate_id.",
    });
    throw new OtpVerificationError("No pending login code found. Please request a new code.");
  }

  const otp = otpRes.rows[0];

  if (new Date(otp.expires_at).getTime() < Date.now()) {
    await logAudit({
      entity_type: "APPLICANT_PORTAL",
      entity_id: candidateId,
      agent_or_user: "SYSTEM",
      action: "APPLICANT_OTP_VERIFY_FAILED",
      reason_code: "OTP_EXPIRED",
      reason_comment: "The login code had already expired at verification time.",
    });
    throw new OtpVerificationError("This login code has expired. Please request a new one.");
  }

  if (otp.attempts >= otp.max_attempts) {
    await logAudit({
      entity_type: "APPLICANT_PORTAL",
      entity_id: candidateId,
      agent_or_user: "SYSTEM",
      action: "APPLICANT_OTP_VERIFY_FAILED",
      reason_code: "OTP_MAX_ATTEMPTS_EXCEEDED",
      reason_comment: `Maximum verification attempts (${otp.max_attempts}) exceeded for this code.`,
    });
    throw new OtpVerificationError("Too many incorrect attempts. Please request a new code.");
  }

  const candidateHash = hashOtp(code, candidateId);
  if (candidateHash !== otp.code_hash) {
    await db.query(`UPDATE applicant_otp_requests SET attempts=attempts+1 WHERE request_id=$1`, [otp.request_id]);
    await logAudit({
      entity_type: "APPLICANT_PORTAL",
      entity_id: candidateId,
      agent_or_user: "SYSTEM",
      action: "APPLICANT_OTP_VERIFY_FAILED",
      reason_code: "OTP_MISMATCH",
      reason_comment: `Incorrect code submitted (attempt ${otp.attempts + 1} of ${otp.max_attempts}).`,
    });
    throw new OtpVerificationError("Incorrect code. Please try again.");
  }

  const candidateRes = await db.query(`SELECT candidate_id, org_id FROM candidates WHERE candidate_id=$1`, [candidateId]);
  if (candidateRes.rowCount === 0) {
    throw new OtpVerificationError("Application record not found.");
  }
  const orgId = candidateRes.rows[0].org_id;

  await db.query(`UPDATE applicant_otp_requests SET consumed_at=now() WHERE request_id=$1`, [otp.request_id]);

  const token = jwt.sign({ user_id: candidateId, org_id: orgId, role: "APPLICANT" }, env.JWT_SECRET, { expiresIn: "1h" });

  await logAudit({
    entity_type: "APPLICANT_PORTAL",
    entity_id: candidateId,
    agent_or_user: candidateId,
    action: "APPLICANT_LOGIN_SUCCESS",
    reason_code: "OTP_VERIFIED",
    reason_comment: "Applicant authenticated successfully via one-time code; session token issued (expires in 1 hour).",
  });

  return { token, candidate_id: candidateId, org_id: orgId };
}

// ---------------------------------------------------------------------
// Deterministic, rule-based reason description synthesis. The core
// eligibility engine (Phase 1-2) stores reason_code on evaluation_results
// but has no free-text description column; rather than modify that
// existing schema, the portal builds a plain-language description at
// read time from the rule's own visible fields (field_path, operator,
// threshold_value) — a template substitution, not a generated summary,
// so it stays fully deterministic and auditable (no LLM).
// ---------------------------------------------------------------------

const OPERATOR_PHRASES: Record<string, string> = {
  EQ: "equal to",
  NEQ: "not equal to",
  LT: "less than",
  LTE: "less than or equal to",
  GT: "greater than",
  GTE: "greater than or equal to",
  IN: "one of",
  NOT_IN: "not one of",
  REGEX: "matching the required pattern",
};

export function describeRuleOutcome(status: "PASS" | "FAIL" | "NEEDS_REVIEW", fieldPath: string, operator: string, thresholdValue: unknown): string {
  const phrase = OPERATOR_PHRASES[operator] ?? operator;
  const thresholdText = Array.isArray(thresholdValue) ? thresholdValue.join(", ") : String(thresholdValue);
  const requirement = `The rule requires "${fieldPath}" to be ${phrase} ${thresholdText}.`;

  if (status === "PASS") return `${requirement} Your submitted value met this requirement.`;
  if (status === "NEEDS_REVIEW") return `${requirement} Your submitted value is close to the threshold and a human reviewer is checking it.`;
  return `${requirement} Your submitted value did not meet this requirement.`;
}

// ---------------------------------------------------------------------
// Candidate application-stage mapping — deterministic, same input
// (candidates.status) always yields the same stage label / pill color.
// ---------------------------------------------------------------------

const STAGE_MAP: Record<string, { label: ApplicantStageLabel; pill: ApplicantStatusView["stage_pill"]; reason: string }> = {
  INTAKE: { label: "Application Received", pill: "neutral", reason: "Your application has been received and is queued for screening." },
  PARSED: { label: "Application Received", pill: "neutral", reason: "Your application details have been extracted and are queued for eligibility screening." },
  ELIGIBILITY_DONE: { label: "Eligibility Confirmed", pill: "green", reason: "Your application has passed the automated eligibility checks." },
  SCORED: { label: "Scored", pill: "green", reason: "Your application has been scored against the position's criteria." },
  NEEDS_REVIEW: { label: "Needs Review", pill: "amber", reason: "One or more checks on your application need a human reviewer's attention." },
  ELIGIBLE_APPROVED: { label: "Eligibility Confirmed", pill: "green", reason: "A human reviewer has confirmed your eligibility." },
  SHORTLISTED: { label: "Shortlisted", pill: "green", reason: "You have been shortlisted for the next stage." },
  VERIFIED: { label: "Verified", pill: "green", reason: "Your documents and background checks have been verified." },
  REJECTED: { label: "Rejected", pill: "red", reason: "Your application was not shortlisted. See the reasons below for details." },
  SELECTED: { label: "Selected", pill: "green", reason: "Congratulations — you have been selected." },
  WITHDRAWN: { label: "Withdrawn", pill: "neutral", reason: "This application has been withdrawn." },
};

function stageFor(candidateStatus: string) {
  return STAGE_MAP[candidateStatus] ?? { label: "Application Received" as ApplicantStageLabel, pill: "neutral" as const, reason: "Your application is being processed." };
}

async function loadPortalConfig(orgId: string): Promise<ApplicantPortalConfig> {
  const res = await db.query<ApplicantPortalConfig>(`SELECT * FROM applicant_portal_configs WHERE org_id=$1`, [orgId]);
  if (res.rowCount === 0) {
    // Safe, transparent defaults — matches the migration's column defaults.
    return {
      org_id: orgId,
      visible_reason_codes: null,
      estimated_timeline_text: "Updates are typically posted within 2-3 weeks of each stage.",
      appeal_enabled: true,
      localized_messages: {},
      default_language: "en",
      updated_by: null,
      updated_at: new Date().toISOString(),
    };
  }
  return res.rows[0];
}

/**
 * Pure, deterministic visibility filter — the "configurable per org
 * which reason codes are visible" requirement. Applicants never see
 * PASS rows (nothing to explain), and a non-null allowlist restricts
 * further to only those reason_codes. Extracted as a standalone
 * function so this policy is independently unit-testable without a DB.
 */
export function filterReasonsByVisibility<T extends { reason_code: string; status: string }>(
  rows: T[],
  allowlist: string[] | null
): T[] {
  return rows.filter((row) => row.status !== "PASS").filter((row) => !allowlist || allowlist.includes(row.reason_code));
}

/**
 * Assembles the full read-only applicant status view: stage, filtered
 * reason codes with evidence, evidence documents, localized timeline
 * text, and appeal availability. Every field required by the Global
 * Reasoning Standard (reason_code, reason_description, evidence) is
 * populated deterministically from already-computed data — nothing is
 * decided here, only presented. Every view is audited.
 */
export async function getApplicantStatusView(candidateId: string, orgId: string, language?: string): Promise<ApplicantStatusView> {
  const candidateRes = await db.query(`SELECT * FROM candidates WHERE candidate_id=$1 AND org_id=$2`, [candidateId, orgId]);
  if (candidateRes.rowCount === 0) {
    throw new Error(`Application not found: ${candidateId}`);
  }
  const candidate = candidateRes.rows[0];

  const config = await loadPortalConfig(orgId);
  const lang = language && config.localized_messages[language] ? language : config.default_language;
  const localized = config.localized_messages[lang];

  const evalRes = await db.query(
    `SELECT er.*, r.field_path, r.operator, r.threshold_value, r.rule_code
     FROM evaluation_results er
     JOIN rules r ON r.rule_id = er.rule_id
     WHERE er.candidate_id=$1 AND er.org_id=$2
     ORDER BY er.evaluated_at DESC`,
    [candidateId, orgId]
  );

  const reasons: ApplicantReasonEntry[] = filterReasonsByVisibility(evalRes.rows, config.visible_reason_codes).map((row: any) => ({
    reason_code: row.reason_code,
    reason_description: describeRuleOutcome(row.status, row.field_path, row.operator, row.threshold_value),
    status: row.status,
    evidence: {
      rule_applied: row.rule_code,
      field_path: row.field_path,
      extracted_value: row.input_value,
      confidence: row.confidence !== null ? Number(row.confidence) : null,
    },
    evaluated_at: row.evaluated_at,
  }));

  const docsRes = await db.query(`SELECT doc_type, verification_status FROM candidate_documents WHERE candidate_id=$1`, [candidateId]);

  const stage = stageFor(candidate.status);
  const timelineText = localized?.estimated_timeline_text ?? config.estimated_timeline_text;
  const nextUpdateText =
    localized?.next_update_text ??
    (stage.pill === "red" || stage.label === "Selected" || stage.label === "Withdrawn"
      ? "This application has reached a final stage; no further automatic updates are expected."
      : `The next update will appear here once your application moves to its next stage. ${timelineText}`);

  await logAudit({
    entity_type: "APPLICANT_PORTAL",
    entity_id: candidateId,
    agent_or_user: candidateId,
    action: "APPLICANT_STATUS_VIEWED",
    reason_code: "STATUS_VIEW_SERVED",
    reason_comment: `Applicant viewed their own status: stage=${stage.label}, ${reasons.length} reason(s) shown.`,
  });

  return {
    candidate_id: candidate.candidate_id,
    full_name: candidate.full_name,
    position_applied: candidate.position_applied,
    job_circular_id: candidate.job_circular_id,
    stage: stage.label,
    stage_pill: stage.pill,
    reasons,
    evidence_documents: docsRes.rows,
    estimated_timeline_text: timelineText,
    next_expected_update: nextUpdateText,
    appeal_enabled: config.appeal_enabled,
    language: lang,
    reason_code: `STAGE_${candidate.status}`,
    reason_description: stage.reason,
  };
}

// ---------------------------------------------------------------------
// Org admin configuration
// ---------------------------------------------------------------------

export interface UpsertPortalConfigInput {
  visible_reason_codes?: string[] | null;
  estimated_timeline_text?: string;
  appeal_enabled?: boolean;
  localized_messages?: Record<string, { estimated_timeline_text?: string; next_update_text?: string }>;
  default_language?: string;
}

export async function upsertPortalConfig(orgId: string, input: UpsertPortalConfigInput, actorUserId: string): Promise<ApplicantPortalConfig> {
  const existing = await db.query(`SELECT * FROM applicant_portal_configs WHERE org_id=$1`, [orgId]);

  let result;
  if (existing.rowCount === 0) {
    result = await db.query(
      `INSERT INTO applicant_portal_configs
        (org_id, visible_reason_codes, estimated_timeline_text, appeal_enabled, localized_messages, default_language, updated_by)
       VALUES ($1,$2,COALESCE($3,'Updates are typically posted within 2-3 weeks of each stage.'),COALESCE($4,true),COALESCE($5,'{}'::jsonb),COALESCE($6,'en'),$7)
       RETURNING *`,
      [
        orgId,
        input.visible_reason_codes ?? null,
        input.estimated_timeline_text ?? null,
        input.appeal_enabled ?? null,
        input.localized_messages ? JSON.stringify(input.localized_messages) : null,
        input.default_language ?? null,
        actorUserId,
      ]
    );
  } else {
    const current = existing.rows[0];
    result = await db.query(
      `UPDATE applicant_portal_configs
       SET visible_reason_codes=$1, estimated_timeline_text=$2, appeal_enabled=$3, localized_messages=$4, default_language=$5, updated_by=$6, updated_at=now()
       WHERE org_id=$7 RETURNING *`,
      [
        input.visible_reason_codes !== undefined ? input.visible_reason_codes : current.visible_reason_codes,
        input.estimated_timeline_text ?? current.estimated_timeline_text,
        input.appeal_enabled !== undefined ? input.appeal_enabled : current.appeal_enabled,
        JSON.stringify(input.localized_messages ?? current.localized_messages),
        input.default_language ?? current.default_language,
        actorUserId,
        orgId,
      ]
    );
  }

  await logAudit({
    entity_type: "APPLICANT_PORTAL_CONFIG",
    entity_id: orgId,
    agent_or_user: actorUserId,
    action: "APPLICANT_PORTAL_CONFIG_UPDATED",
    reason_code: "CONFIG_UPDATED",
    reason_comment: "Org admin updated applicant portal visibility/localization settings.",
    output_value: input,
  });

  return result.rows[0];
}
