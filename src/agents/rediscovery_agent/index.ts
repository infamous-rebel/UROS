import { createHmac, timingSafeEqual } from "crypto";
import { db } from "../../database/client";
import { env } from "../../config/env.schema";
import { logAudit } from "../../utils/audit_helper";
import { logger } from "../../utils/logger";
import { assembleCandidateProfile } from "../dimension_scoring_agent";
import { evaluateFit } from "../persona_agent";
import { sendBatch, CommunicationChannel } from "../communication_agent";
import { Candidate } from "../../models/candidate.model";
import { PersonaRequirement } from "../../models/hr.model";
import {
  RediscoveryConsent,
  RediscoveryConsentStatus,
  RediscoverySuggestion,
  RediscoverySuggestionStatus,
  RediscoveryOutreach,
  RediscoveryRunParams,
  RediscoveryRunResult,
  RediscoveryEvidence,
} from "../../models/rediscovery.model";

/**
 * Feature 10: Candidate Rediscovery / Talent Pool Re-engagement.
 *
 * Matches previously REJECTED/WITHDRAWN candidates against a new
 * circular/persona by reusing two existing agents rather than
 * duplicating scoring logic:
 *  - dimension_scoring_agent.assembleCandidateProfile: builds the same
 *    flat, deterministic candidate profile the 7-Dimension Matching
 *    feature uses.
 *  - persona_agent.evaluateFit: the same deterministic weighted-operator
 *    scoring the Departmental Persona / Job Matching feature uses.
 *
 * The agent NEVER finalizes anything:
 *  - runRediscoveryMatch only ever writes PENDING_REVIEW suggestions.
 *  - Only a human, via reviewSuggestion (PATCH .../suggestions/:id),
 *    can set APPROVED/REJECTED.
 *  - sendOutreachBatch only sends for suggestions already APPROVED by a
 *    human, and is itself only ever called by a human action (an HTTP
 *    request), never automatically.
 * (UROS_Global_Reasoning_Standard.md; Core Principle: Human-in-the-Loop.)
 */

// -----------------------------------------------------------------------
// Consent token (public opt-in/opt-out link, no login required)
// -----------------------------------------------------------------------

/**
 * Deterministic per-candidate HMAC, not a stored one-time token like
 * reference_check_agent's respond link. Rediscovery consent is a
 * standing yes/no the candidate may revisit any time (unlike a
 * single-use referee questionnaire), so a stable, recomputable token
 * embedded in every re-engagement/status message is more appropriate
 * than an expiring, single-use row. It cannot be forged without
 * env.JWT_SECRET, and it reveals nothing about the candidate beyond
 * what the candidate_id in the URL already does.
 */
export function computeConsentTokenWithSecret(candidateId: string, secret: string): string {
  return createHmac("sha256", secret).update(candidateId).digest("hex");
}

export function generateConsentToken(candidateId: string): string {
  return computeConsentTokenWithSecret(candidateId, env.JWT_SECRET);
}

/** Constant-time comparison — never leaks token validity via timing. */
export function verifyConsentToken(candidateId: string, token: string): boolean {
  if (!/^[a-f0-9]{64}$/.test(token)) return false;
  const expected = generateConsentToken(candidateId);
  return timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(token, "hex"));
}

// -----------------------------------------------------------------------
// Consent management (I/O)
// -----------------------------------------------------------------------

/**
 * Upserts the candidate's rediscovery consent state. `actorUserId` is a
 * staff user_id when recorded internally (e.g. during a phone call), or
 * the literal `"CANDIDATE_SELF"` when the candidate submitted it
 * themselves via the public token link — never null, so the audit trail
 * always shows who asserted the consent.
 */
export async function setRediscoveryConsent(
  candidateId: string,
  orgId: string,
  optedIn: boolean,
  actorUserId: string
): Promise<RediscoveryConsent> {
  const candidateRes = await db.query(`SELECT candidate_id FROM candidates WHERE candidate_id=$1 AND org_id=$2`, [
    candidateId,
    orgId,
  ]);
  if (candidateRes.rowCount === 0) {
    throw new Error(`Candidate not found: ${candidateId}`);
  }

  const existing = await db.query<RediscoveryConsent>(`SELECT * FROM rediscovery_consents WHERE candidate_id=$1`, [
    candidateId,
  ]);

  let row: RediscoveryConsent;
  if (existing.rowCount === 0) {
    const inserted = await db.query<RediscoveryConsent>(
      `INSERT INTO rediscovery_consents (candidate_id, org_id, opted_in, opted_in_at, opted_out_at)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [candidateId, orgId, optedIn, optedIn ? new Date().toISOString() : null, optedIn ? null : new Date().toISOString()]
    );
    row = inserted.rows[0];
  } else {
    const updated = await db.query<RediscoveryConsent>(
      `UPDATE rediscovery_consents
       SET opted_in=$1, opted_in_at=$2, opted_out_at=$3, updated_at=now()
       WHERE candidate_id=$4 RETURNING *`,
      [optedIn, optedIn ? new Date().toISOString() : null, optedIn ? null : new Date().toISOString(), candidateId]
    );
    row = updated.rows[0];
  }

  await logAudit({
    org_id: orgId,
    entity_type: "REDISCOVERY_CONSENT",
    entity_id: candidateId,
    agent_or_user: actorUserId,
    action: optedIn ? "REDISCOVERY_OPTED_IN" : "REDISCOVERY_OPTED_OUT",
    output_value: { opted_in: optedIn },
    reason_code: optedIn ? "REDISCOVERY_OPTED_IN" : "REDISCOVERY_OPTED_OUT",
    reason_comment: optedIn
      ? "Candidate consented to being re-contacted about future circulars."
      : "Candidate withdrew consent to be re-contacted about future circulars.",
  });

  return row;
}

/** Returns the candidate's current consent state, or null if never recorded (treated as NO_RECORD by callers). */
export async function getRediscoveryConsent(candidateId: string, orgId: string): Promise<RediscoveryConsent | null> {
  const res = await db.query<RediscoveryConsent>(
    `SELECT c.* FROM rediscovery_consents c
     JOIN candidates cand ON cand.candidate_id = c.candidate_id
     WHERE c.candidate_id=$1 AND cand.org_id=$2`,
    [candidateId, orgId]
  );
  return res.rowCount === 0 ? null : res.rows[0];
}

// -----------------------------------------------------------------------
// Deterministic eligibility filtering (pure — unit-tested directly)
// -----------------------------------------------------------------------

export interface CandidatePoolRow {
  candidate_id: string;
  status: string;
  updated_at: string;
  job_circular_id: string | null;
  position_applied: string | null;
}

export interface EligibilityFilterInput {
  candidates: CandidatePoolRow[];
  fraudFlaggedIds: Set<string>;
  /** true = explicit opt-in, false = explicit opt-out. A candidate_id absent from this map has no consent record. */
  consentByCandidate: Map<string, boolean>;
  alreadySuggestedIds: Set<string>;
  requireOptIn: boolean;
  /** Candidates whose updated_at is more recent than this ISO timestamp are excluded (too soon after their last decision). */
  cutoffIso: string;
}

export interface EligibilityFilterOutput {
  eligible: CandidatePoolRow[];
  excludedAlreadySuggested: string[];
  excludedRecent: string[];
  excludedFraud: string[];
  excludedConsent: string[];
}

/**
 * Deterministic, side-effect-free exclusion pipeline. Every candidate
 * falls into exactly one bucket, checked in a fixed priority order so
 * results are always reproducible for the same input:
 *   1. already suggested for this circular (idempotent reruns)
 *   2. too recent since their last status change (cooldown)
 *   3. has an open/confirmed/escalated fraud flag
 *   4. consent: explicit opt-out always excludes; explicit opt-in always
 *      passes; no record excludes only when requireOptIn is true.
 */
export function filterEligibleCandidates(input: EligibilityFilterInput): EligibilityFilterOutput {
  const eligible: CandidatePoolRow[] = [];
  const excludedAlreadySuggested: string[] = [];
  const excludedRecent: string[] = [];
  const excludedFraud: string[] = [];
  const excludedConsent: string[] = [];

  for (const c of input.candidates) {
    if (input.alreadySuggestedIds.has(c.candidate_id)) {
      excludedAlreadySuggested.push(c.candidate_id);
      continue;
    }
    if (c.updated_at > input.cutoffIso) {
      excludedRecent.push(c.candidate_id);
      continue;
    }
    if (input.fraudFlaggedIds.has(c.candidate_id)) {
      excludedFraud.push(c.candidate_id);
      continue;
    }
    const consent = input.consentByCandidate.get(c.candidate_id);
    if (consent === false) {
      excludedConsent.push(c.candidate_id);
      continue;
    }
    if (consent === undefined && input.requireOptIn) {
      excludedConsent.push(c.candidate_id);
      continue;
    }
    eligible.push(c);
  }

  return { eligible, excludedAlreadySuggested, excludedRecent, excludedFraud, excludedConsent };
}

/** Pure: consent status label used in stored evidence, given the same lookup the filter above uses. */
export function resolveConsentStatus(consent: boolean | undefined): RediscoveryConsentStatus {
  if (consent === true) return "OPTED_IN";
  if (consent === false) return "OPTED_OUT";
  return "NO_RECORD";
}

/** Pure: whole-days between two ISO timestamps (b - a), floored, never negative. */
export function daysBetween(aIso: string, bIso: string): number {
  const ms = new Date(bIso).getTime() - new Date(aIso).getTime();
  return Math.max(0, Math.floor(ms / (1000 * 60 * 60 * 24)));
}

/** Pure: cutoff ISO timestamp such that a candidate updated after it is "too recent". */
export function computeCutoffIso(nowIso: string, minDaysSinceDecision: number): string {
  const cutoffMs = new Date(nowIso).getTime() - minDaysSinceDecision * 24 * 60 * 60 * 1000;
  return new Date(cutoffMs).toISOString();
}

/** Pure: builds the mandatory reason_code/reason_description for a qualifying suggestion. */
export function buildSuggestionReason(
  fitScore: number,
  personaName: string,
  targetPosition: string | null,
  targetCircularId: string,
  matchedCount: number,
  totalCount: number
): { reason_code: string; reason_description: string } {
  return {
    reason_code: "REDISCOVERY_MATCH_SUGGESTED",
    reason_description: `Candidate scored ${fitScore}/100 against persona "${personaName}" (matched ${matchedCount}/${totalCount} requirements) for ${
      targetPosition ?? "the position"
    } under circular ${targetCircularId}.`,
  };
}

// -----------------------------------------------------------------------
// Matching run (I/O orchestration)
// -----------------------------------------------------------------------

export const DEFAULT_RUN_PARAMS: Pick<RediscoveryRunParams, "min_fit_score" | "min_days_since_decision" | "require_opt_in" | "max_candidates"> = {
  min_fit_score: 50,
  min_days_since_decision: 90,
  require_opt_in: true,
  max_candidates: 200,
};

/**
 * POST /api/v1/rediscovery/run. Loads the eligible candidate pool,
 * deterministically filters it (consent, fraud, cooldown, not already
 * suggested), scores each remaining candidate against the target
 * persona via assembleCandidateProfile + evaluateFit, and writes a
 * PENDING_REVIEW suggestion row for every candidate at or above
 * min_fit_score. Below-threshold candidates are scored but never
 * stored — this is a suggestion feature, not a full audit of every
 * candidate considered (the run summary's counts are still returned so
 * nothing is silently dropped from view).
 */
export async function runRediscoveryMatch(
  orgId: string,
  params: RediscoveryRunParams,
  actorUserId: string
): Promise<RediscoveryRunResult> {
  const personaRes = await db.query<{ persona_id: string; name: string }>(
    `SELECT persona_id, name FROM personas WHERE persona_id=$1 AND org_id=$2 AND active=true`,
    [params.persona_id, orgId]
  );
  if (personaRes.rowCount === 0) {
    throw new Error(`Active persona not found: ${params.persona_id}`);
  }
  const persona = personaRes.rows[0];

  const requirementsRes = await db.query<PersonaRequirement>(
    `SELECT * FROM persona_requirements WHERE persona_id=$1`,
    [params.persona_id]
  );
  if (requirementsRes.rowCount === 0) {
    throw new Error(`Persona ${params.persona_id} has no requirements configured; cannot compute a fit score.`);
  }
  const requirements = requirementsRes.rows;

  const cutoffIso = computeCutoffIso(new Date().toISOString(), params.min_days_since_decision);

  const poolRes = await db.query<CandidatePoolRow>(
    `SELECT candidate_id, status, updated_at, job_circular_id, position_applied
     FROM candidates
     WHERE org_id=$1 AND status IN ('REJECTED','WITHDRAWN')
     ORDER BY candidate_id ASC
     LIMIT $2`,
    [orgId, params.max_candidates]
  );
  const pool = poolRes.rows;

  if (pool.length === 0) {
    return {
      target_circular_id: params.target_circular_id,
      persona_id: params.persona_id,
      candidates_considered: 0,
      candidates_excluded_recent: 0,
      candidates_excluded_fraud: 0,
      candidates_excluded_consent: 0,
      candidates_excluded_already_suggested: 0,
      candidates_below_threshold: 0,
      suggestions_created: [],
    };
  }

  const candidateIds = pool.map((c) => c.candidate_id);

  const [alreadySuggestedRes, fraudRes, consentRes] = await Promise.all([
    db.query<{ candidate_id: string }>(
      `SELECT candidate_id FROM rediscovery_suggestions WHERE target_circular_id=$1 AND candidate_id = ANY($2::text[])`,
      [params.target_circular_id, candidateIds]
    ),
    db.query<{ candidate_id: string }>(
      `SELECT DISTINCT candidate_id FROM fraud_flags WHERE org_id=$1 AND status IN ('OPEN','CONFIRMED','ESCALATED') AND candidate_id = ANY($2::text[])`,
      [orgId, candidateIds]
    ),
    db.query<{ candidate_id: string; opted_in: boolean }>(
      `SELECT candidate_id, opted_in FROM rediscovery_consents WHERE candidate_id = ANY($1::text[])`,
      [candidateIds]
    ),
  ]);

  const alreadySuggestedIds = new Set(alreadySuggestedRes.rows.map((r) => r.candidate_id));
  const fraudFlaggedIds = new Set(fraudRes.rows.map((r) => r.candidate_id));
  const consentByCandidate = new Map(consentRes.rows.map((r) => [r.candidate_id, r.opted_in]));

  const filtered = filterEligibleCandidates({
    candidates: pool,
    fraudFlaggedIds,
    consentByCandidate,
    alreadySuggestedIds,
    requireOptIn: params.require_opt_in,
    cutoffIso,
  });

  const nowIso = new Date().toISOString();
  const suggestionsCreated: RediscoverySuggestion[] = [];
  let belowThreshold = 0;

  for (const candidate of filtered.eligible) {
    // Per-candidate error isolation (Agent-Level Hardening): one candidate
    // whose profile cannot be assembled, or whose suggestion row cannot be
    // written, must not abort the whole run and discard every other
    // suggestion. The failure is logged, audited (so a human can act on it)
    // and the loop continues. The response shape is unchanged.
    try {
      const profile = await assembleCandidateProfile(candidate.candidate_id, orgId);
      const fit = evaluateFit(profile as unknown as Record<string, unknown>, requirements);

      if (fit.fit_score < params.min_fit_score) {
        belowThreshold += 1;
        continue;
      }

      const consentFlag = consentByCandidate.get(candidate.candidate_id);
      const evidence: RediscoveryEvidence = {
        fit_score: fit.fit_score,
        breakdown: fit.breakdown,
        matched: fit.matched,
        unmatched: fit.unmatched,
        persona_id: params.persona_id,
        target_circular_id: params.target_circular_id,
        target_position: params.target_position,
        previous_status: candidate.status,
        previous_job_circular_id: candidate.job_circular_id,
        previous_position_applied: candidate.position_applied,
        consent_status: resolveConsentStatus(consentFlag),
        exclusion_checks: {
          fraud_flag_free: true,
          cooldown_days: params.min_days_since_decision,
          days_since_last_update: daysBetween(candidate.updated_at, nowIso),
          not_previously_suggested_for_circular: true,
          require_opt_in: params.require_opt_in,
        },
      };

      const { reason_code, reason_description } = buildSuggestionReason(
        fit.fit_score,
        persona.name,
        params.target_position,
        params.target_circular_id,
        fit.matched.length,
        fit.matched.length + fit.unmatched.length
      );

      const inserted = await db.query<RediscoverySuggestion>(
        `INSERT INTO rediscovery_suggestions
          (org_id, candidate_id, target_circular_id, target_position, fit_score, reason_code, reason_description, evidence, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'PENDING_REVIEW')
         RETURNING *`,
        [
          orgId,
          candidate.candidate_id,
          params.target_circular_id,
          params.target_position,
          fit.fit_score,
          reason_code,
          reason_description,
          JSON.stringify(evidence),
        ]
      );
      const suggestion = inserted.rows[0];
      suggestionsCreated.push(suggestion);

      await logAudit({
        org_id: orgId,
        entity_type: "REDISCOVERY_SUGGESTION",
        entity_id: suggestion.suggestion_id,
        agent_or_user: "RediscoveryAgent",
        action: "REDISCOVERY_SUGGESTION_CREATED",
        input_value: { candidate_id: candidate.candidate_id, persona_id: params.persona_id, target_circular_id: params.target_circular_id },
        output_value: { fit_score: fit.fit_score, status: "PENDING_REVIEW" },
        reason_code,
        reason_comment: reason_description,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error("REDISCOVERY_CANDIDATE_FAILED", {
        candidate_id: candidate.candidate_id,
        target_circular_id: params.target_circular_id,
        error: message,
      });
      await logAudit({
        org_id: orgId,
        entity_type: "REDISCOVERY_RUN",
        entity_id: params.target_circular_id,
        agent_or_user: "RediscoveryAgent",
        action: "REDISCOVERY_CANDIDATE_FAILED",
        input_value: { candidate_id: candidate.candidate_id, persona_id: params.persona_id },
        reason_code: "REDISCOVERY_ITEM_ERROR",
        reason_comment: `Candidate ${candidate.candidate_id} could not be evaluated for rediscovery; the remaining candidates continued. Error: ${message}`,
      });
    }
  }

  await logAudit({
    org_id: orgId,
    entity_type: "REDISCOVERY_RUN",
    entity_id: params.target_circular_id,
    agent_or_user: actorUserId,
    action: "REDISCOVERY_RUN_COMPLETED",
    input_value: { ...params },
    output_value: {
      candidates_considered: pool.length,
      suggestions_created: suggestionsCreated.length,
      excluded_recent: filtered.excludedRecent.length,
      excluded_fraud: filtered.excludedFraud.length,
      excluded_consent: filtered.excludedConsent.length,
      excluded_already_suggested: filtered.excludedAlreadySuggested.length,
      below_threshold: belowThreshold,
    },
    reason_code: "REDISCOVERY_RUN_COMPLETED",
    reason_comment: `Rediscovery run for circular ${params.target_circular_id}: ${suggestionsCreated.length} suggestion(s) created out of ${pool.length} candidate(s) considered.`,
  });

  return {
    target_circular_id: params.target_circular_id,
    persona_id: params.persona_id,
    candidates_considered: pool.length,
    candidates_excluded_recent: filtered.excludedRecent.length,
    candidates_excluded_fraud: filtered.excludedFraud.length,
    candidates_excluded_consent: filtered.excludedConsent.length,
    candidates_excluded_already_suggested: filtered.excludedAlreadySuggested.length,
    candidates_below_threshold: belowThreshold,
    suggestions_created: suggestionsCreated,
  };
}

// -----------------------------------------------------------------------
// Suggestion listing and review (I/O)
// -----------------------------------------------------------------------

export interface ListSuggestionsFilters {
  target_circular_id?: string;
  status?: RediscoverySuggestionStatus;
  limit: number;
  offset: number;
}

export async function listRediscoverySuggestions(
  orgId: string,
  filters: ListSuggestionsFilters
): Promise<{ suggestions: RediscoverySuggestion[]; count: number }> {
  const conditions: string[] = ["org_id=$1"];
  const values: unknown[] = [orgId];

  if (filters.target_circular_id) {
    values.push(filters.target_circular_id);
    conditions.push(`target_circular_id=$${values.length}`);
  }
  if (filters.status) {
    values.push(filters.status);
    conditions.push(`status=$${values.length}`);
  }

  values.push(filters.limit);
  const limitIdx = values.length;
  values.push(filters.offset);
  const offsetIdx = values.length;

  const res = await db.query<RediscoverySuggestion>(
    `SELECT * FROM rediscovery_suggestions
     WHERE ${conditions.join(" AND ")}
     ORDER BY fit_score DESC, created_at ASC
     LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
    values
  );

  return { suggestions: res.rows, count: res.rowCount ?? 0 };
}

export class RediscoveryReviewError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RediscoveryReviewError";
  }
}

/**
 * PATCH /api/v1/rediscovery/suggestions/:suggestion_id — the ONLY path
 * by which a suggestion is ever finalized. Only a PENDING_REVIEW
 * suggestion can be approved/rejected; the decision is terminal (no
 * further transitions) since, unlike offboarding steps, there is no
 * "redo" workflow here — a rejected suggestion simply is not acted on,
 * and a fresh POST /run will naturally produce a new suggestion on a
 * later attempt if the candidate is still eligible.
 */
export async function reviewSuggestion(
  suggestionId: string,
  orgId: string,
  actorUserId: string,
  action: "APPROVE" | "REJECT",
  reason: string
): Promise<RediscoverySuggestion> {
  if (!reason || reason.trim().length === 0) {
    throw new Error("A reason is mandatory for approving or rejecting a rediscovery suggestion");
  }

  const existingRes = await db.query<RediscoverySuggestion>(
    `SELECT * FROM rediscovery_suggestions WHERE suggestion_id=$1 AND org_id=$2`,
    [suggestionId, orgId]
  );
  if (existingRes.rowCount === 0) {
    throw new Error(`Rediscovery suggestion not found: ${suggestionId}`);
  }
  const existing = existingRes.rows[0];
  if (existing.status !== "PENDING_REVIEW") {
    throw new RediscoveryReviewError(
      `Suggestion ${suggestionId} has already been ${existing.status.toLowerCase()} and cannot be reviewed again`
    );
  }

  const newStatus: RediscoverySuggestionStatus = action === "APPROVE" ? "APPROVED" : "REJECTED";
  const updated = await db.query<RediscoverySuggestion>(
    `UPDATE rediscovery_suggestions
     SET status=$1, reviewed_by=$2, reviewed_at=now(), review_reason=$3
     WHERE suggestion_id=$4 RETURNING *`,
    [newStatus, actorUserId, reason, suggestionId]
  );

  await logAudit({
    org_id: orgId,
    entity_type: "REDISCOVERY_SUGGESTION",
    entity_id: suggestionId,
    agent_or_user: actorUserId,
    action: `REDISCOVERY_SUGGESTION_${newStatus}`,
    input_value: { previous_status: "PENDING_REVIEW" },
    output_value: { status: newStatus },
    reason_code: newStatus === "APPROVED" ? "REDISCOVERY_SUGGESTION_APPROVED_BY_HUMAN" : "REDISCOVERY_SUGGESTION_REJECTED_BY_HUMAN",
    reason_comment: reason,
  });

  return updated.rows[0];
}

// -----------------------------------------------------------------------
// Outreach (I/O) — human-triggered only, never automatic
// -----------------------------------------------------------------------

export interface OutreachBatchResult {
  sent: RediscoveryOutreach[];
  skipped: { suggestion_id: string; reason: string }[];
}

/**
 * POST /api/v1/rediscovery/outreach. Sends the given approved
 * suggestions' outreach message via the existing Communication Hub
 * (sendBatch — same function every other UROS feature uses, so
 * template-language resolution and communication_log are unaffected),
 * then records a rediscovery-specific outreach row so the response can
 * be tracked. Re-checks status=APPROVED and current consent at send
 * time (not just at approval time) — consent may have been withdrawn
 * between approval and send.
 */
export async function sendOutreachBatch(
  suggestionIds: string[],
  channel: CommunicationChannel,
  templateCode: string,
  orgId: string,
  actorUserId: string
): Promise<OutreachBatchResult> {
  const sent: RediscoveryOutreach[] = [];
  const skipped: { suggestion_id: string; reason: string }[] = [];

  for (const suggestionId of suggestionIds) {
    // Per-item error isolation (Agent-Level Hardening): a send that throws
    // (provider down, candidate row missing mid-flight) is recorded in the
    // same `skipped` list the caller already renders, so a human sees the
    // reason and the rest of the batch still goes out.
    try {
      const suggestionRes = await db.query<RediscoverySuggestion>(
        `SELECT * FROM rediscovery_suggestions WHERE suggestion_id=$1 AND org_id=$2`,
        [suggestionId, orgId]
      );
      if (suggestionRes.rowCount === 0) {
        skipped.push({ suggestion_id: suggestionId, reason: "Suggestion not found" });
        continue;
      }
      const suggestion = suggestionRes.rows[0];
      if (suggestion.status !== "APPROVED") {
        skipped.push({ suggestion_id: suggestionId, reason: `Suggestion status is ${suggestion.status}, not APPROVED` });
        continue;
      }

      const consentRes = await db.query<{ opted_in: boolean }>(
        `SELECT opted_in FROM rediscovery_consents WHERE candidate_id=$1`,
        [suggestion.candidate_id]
      );
      if (consentRes.rowCount === 0 || consentRes.rows[0].opted_in !== true) {
        skipped.push({ suggestion_id: suggestionId, reason: "Candidate has not opted in (or has withdrawn consent) at send time" });
        continue;
      }

      const candidateRes = await db.query<Candidate>(`SELECT * FROM candidates WHERE candidate_id=$1 AND org_id=$2`, [
        suggestion.candidate_id,
        orgId,
      ]);
      if (candidateRes.rowCount === 0) {
        skipped.push({ suggestion_id: suggestionId, reason: "Candidate record not found" });
        continue;
      }

      await sendBatch([candidateRes.rows[0]], templateCode, channel, orgId);

      const outreachRes = await db.query<RediscoveryOutreach>(
        `INSERT INTO rediscovery_outreach (suggestion_id, channel, template_code, status, response_status)
         VALUES ($1,$2,$3,'SENT','PENDING') RETURNING *`,
        [suggestionId, channel, templateCode]
      );
      const outreach = outreachRes.rows[0];
      sent.push(outreach);

      await logAudit({
        entity_type: "REDISCOVERY_OUTREACH",
        entity_id: outreach.outreach_id,
        agent_or_user: actorUserId,
        action: "REDISCOVERY_OUTREACH_SENT",
        input_value: { suggestion_id: suggestionId, candidate_id: suggestion.candidate_id, channel, template_code: templateCode },
        output_value: { status: "SENT" },
        reason_code: "REDISCOVERY_OUTREACH_SENT_BY_HUMAN",
        reason_comment: `Re-engagement outreach sent for suggestion ${suggestionId} after human approval.`,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      skipped.push({ suggestion_id: suggestionId, reason: `Send failed: ${message}` });
      logger.error("REDISCOVERY_OUTREACH_FAILED", { suggestion_id: suggestionId, error: message });
      await logAudit({
        entity_type: "REDISCOVERY_OUTREACH",
        entity_id: suggestionId,
        agent_or_user: actorUserId,
        action: "REDISCOVERY_OUTREACH_FAILED",
        input_value: { suggestion_id: suggestionId, channel, template_code: templateCode },
        reason_code: "REDISCOVERY_ITEM_ERROR",
        reason_comment: `Outreach for suggestion ${suggestionId} failed and was skipped; the remaining suggestions continued. Error: ${message}`,
      });
    }
  }

  return { sent, skipped };
}

export interface ListOutreachFilters {
  suggestion_id?: string;
  target_circular_id?: string;
  limit: number;
  offset: number;
}

/** Additive beyond the literal spec (mirrors reference.routes.ts's GET /requests/:candidate_id precedent): the UI needs "sent outreach history" and this is the natural org-scoped read for it. Always joins through rediscovery_suggestions for org scoping — rediscovery_outreach has no org_id column of its own. */
export async function listRediscoveryOutreach(
  orgId: string,
  filters: ListOutreachFilters
): Promise<{ outreach: (RediscoveryOutreach & { candidate_id: string; target_circular_id: string })[]; count: number }> {
  const conditions: string[] = ["s.org_id=$1"];
  const values: unknown[] = [orgId];

  if (filters.suggestion_id) {
    values.push(filters.suggestion_id);
    conditions.push(`o.suggestion_id=$${values.length}`);
  }
  if (filters.target_circular_id) {
    values.push(filters.target_circular_id);
    conditions.push(`s.target_circular_id=$${values.length}`);
  }

  values.push(filters.limit);
  const limitIdx = values.length;
  values.push(filters.offset);
  const offsetIdx = values.length;

  const res = await db.query(
    `SELECT o.*, s.candidate_id, s.target_circular_id
     FROM rediscovery_outreach o
     JOIN rediscovery_suggestions s ON s.suggestion_id = o.suggestion_id
     WHERE ${conditions.join(" AND ")}
     ORDER BY o.sent_at DESC
     LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
    values
  );

  return { outreach: res.rows, count: res.rowCount ?? 0 };
}
