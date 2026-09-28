import { createHash, randomBytes } from "crypto";
import { db } from "../../database/client";
import { env } from "../../config/env.schema";
import { logAudit } from "../../utils/audit_helper";
import { sendOutboundEmail } from "../../services/integrations/email";
import { sendTemplateMessage } from "../../services/integrations/whatsapp_business";
import {
  ReferenceQuestion,
  ReferenceQuestionSet,
  ReferenceRequest,
  ReferenceResponseRecord,
  ReferenceResult,
  ReferenceScoringOutcome,
  QuestionScoringOutcome,
} from "../../models/reference.model";

/**
 * Feature 7: Automated Reference Checking.
 *
 * Sends structured, persona-mapped reference questionnaires to referees
 * via the Communication Hub (email/WhatsApp), deterministically scores
 * RATING_1_5 / YES_NO answers, and NEVER auto-scores free-text answers
 * (evidence only — mirrors the Digital Exam Paper Creator's short-answer
 * pattern). The agent's `recommendation` is a suggestion only; the
 * result is only ever finalized by a human via
 * PATCH /api/v1/references/results/:result_id
 * (UROS_Global_Reasoning_Standard.md; Core Principle: Human-in-the-Loop).
 */

// -----------------------------------------------------------------------
// Defaults
// -----------------------------------------------------------------------

/**
 * Used the first time an org ever requests a reference check without
 * having configured a persona-specific or org-wide question set. This
 * mirrors the UI/UX Direction principle "no dead space" / "no blank
 * forms" — reference checking works out of the box, and `configure`
 * only overrides these defaults.
 */
export const DEFAULT_REFERENCE_QUESTIONS: ReferenceQuestion[] = [
  { question_id: "q_overall_performance", text: "How would you rate this candidate's overall job performance (1-5)?", type: "RATING_1_5", weight: 30 },
  { question_id: "q_reliability", text: "How would you rate this candidate's reliability and punctuality (1-5)?", type: "RATING_1_5", weight: 20 },
  { question_id: "q_teamwork", text: "How would you rate this candidate's teamwork and communication (1-5)?", type: "RATING_1_5", weight: 20 },
  { question_id: "q_would_rehire", text: "Would you rehire or work with this candidate again?", type: "YES_NO", weight: 30 },
  { question_id: "q_comments", text: "Any additional comments about this candidate's strengths or areas of concern?", type: "TEXT", weight: 0 },
];

export const RECOMMEND_THRESHOLD_PCT = 70;
export const CONCERN_THRESHOLD_PCT = 40;

export class ReferenceLinkError extends Error {
  constructor(message = "Invalid or expired reference request link") {
    super(message);
    this.name = "ReferenceLinkError";
  }
}

// -----------------------------------------------------------------------
// Token handling (mirrors applicant_portal_agent's OTP hashing pattern)
// -----------------------------------------------------------------------

const TOKEN_PEPPER = () => env.JWT_SECRET;

export function generateReferenceToken(): string {
  return randomBytes(32).toString("hex");
}

export function hashReferenceToken(token: string): string {
  return createHash("sha256").update(`${token}:${TOKEN_PEPPER()}`).digest("hex");
}

// -----------------------------------------------------------------------
// Question set resolution / configuration
// -----------------------------------------------------------------------

/**
 * Resolves the question set a new reference request should use:
 * 1. An active persona-specific set for this org+persona, if configured.
 * 2. An active org-wide default set (persona_id IS NULL), if configured.
 * 3. Otherwise, lazily materializes an org-wide default row from
 *    DEFAULT_REFERENCE_QUESTIONS so that reference_requests.question_set_id
 *    (NOT NULL) always has a real, replayable row to point at.
 */
export async function resolveEffectiveQuestionSet(
  orgId: string,
  personaId: string | null
): Promise<ReferenceQuestionSet> {
  if (personaId) {
    const personaSet = await db.query<ReferenceQuestionSet>(
      `SELECT * FROM reference_question_sets WHERE org_id=$1 AND persona_id=$2 AND active=true`,
      [orgId, personaId]
    );
    if (personaSet.rowCount && personaSet.rowCount > 0) return personaSet.rows[0];
  }

  const orgDefault = await db.query<ReferenceQuestionSet>(
    `SELECT * FROM reference_question_sets WHERE org_id=$1 AND persona_id IS NULL AND active=true`,
    [orgId]
  );
  if (orgDefault.rowCount && orgDefault.rowCount > 0) return orgDefault.rows[0];

  const created = await db.query<ReferenceQuestionSet>(
    `INSERT INTO reference_question_sets (org_id, persona_id, name, questions, version, active, created_by)
     VALUES ($1, NULL, 'UROS Default Reference Questions', $2, 1, true, NULL)
     RETURNING *`,
    [orgId, JSON.stringify(DEFAULT_REFERENCE_QUESTIONS)]
  );
  return created.rows[0];
}

/**
 * POST /api/v1/references/configure — creates a new active version of a
 * question set for (org, persona), deactivating the prior active one.
 * Mirrors the fraud_checks / dimension_configs versioning pattern.
 */
export async function configureQuestionSet(
  orgId: string,
  personaId: string | null,
  name: string,
  questions: ReferenceQuestion[],
  actorUserId: string
): Promise<ReferenceQuestionSet> {
  const seen = new Set<string>();
  for (const q of questions) {
    if (seen.has(q.question_id)) {
      throw new Error(`Duplicate question_id in question set: ${q.question_id}`);
    }
    seen.add(q.question_id);
  }

  const created = await db.withTransaction(async (client) => {
    await client.query(
      `UPDATE reference_question_sets SET active=false
       WHERE org_id=$1 AND COALESCE(persona_id::text,'default')=COALESCE($2::text,'default') AND active=true`,
      [orgId, personaId]
    );

    const priorVersion = await client.query<{ version: number }>(
      `SELECT COALESCE(MAX(version),0) AS version FROM reference_question_sets
       WHERE org_id=$1 AND COALESCE(persona_id::text,'default')=COALESCE($2::text,'default')`,
      [orgId, personaId]
    );
    const nextVersion = (priorVersion.rows[0]?.version ?? 0) + 1;

    const insertRes = await client.query<ReferenceQuestionSet>(
      `INSERT INTO reference_question_sets (org_id, persona_id, name, questions, version, active, created_by)
       VALUES ($1,$2,$3,$4,$5,true,$6)
       RETURNING *`,
      [orgId, personaId, name, JSON.stringify(questions), nextVersion, actorUserId]
    );
    return insertRes.rows[0];
  });

  await logAudit({
    entity_type: "REFERENCE_QUESTION_SET",
    entity_id: created.question_set_id,
    agent_or_user: actorUserId,
    action: "REFERENCE_QUESTION_SET_CONFIGURED",
    output_value: { persona_id: personaId, name, question_count: questions.length, version: created.version },
  });

  return created;
}

// -----------------------------------------------------------------------
// Sending
// -----------------------------------------------------------------------

function buildQuestionnaireText(candidateName: string, respondUrl: string, questions: ReferenceQuestion[]): string {
  const lines = questions.map((q, i) => `${i + 1}. [${q.question_id}] ${q.text}`);
  return (
    `You have been listed as a professional reference for ${candidateName}. ` +
    `Please answer the following questions using this link: ${respondUrl}\n\n` +
    lines.join("\n")
  );
}

export interface CreateReferenceRequestInput {
  candidate_id: string;
  referee_email?: string;
  referee_phone?: string;
  persona_id?: string | null;
}

/**
 * POST /api/v1/references/request — creates the request row, resolves the
 * question set, and sends the questionnaire via email (if referee_email
 * given) or WhatsApp (if only referee_phone given). Returns the
 * plaintext token exactly once; it is never persisted or logged.
 */
export async function createAndSendReferenceRequest(
  input: CreateReferenceRequestInput,
  orgId: string,
  actorUserId: string
): Promise<{ request: ReferenceRequest; token: string }> {
  const candidateRes = await db.query<{ candidate_id: string; full_name: string }>(
    `SELECT candidate_id, full_name FROM candidates WHERE candidate_id=$1 AND org_id=$2`,
    [input.candidate_id, orgId]
  );
  if (candidateRes.rowCount === 0) {
    throw new Error("Candidate not found");
  }
  const candidate = candidateRes.rows[0];

  const questionSet = await resolveEffectiveQuestionSet(orgId, input.persona_id ?? null);

  const token = generateReferenceToken();
  const tokenHash = hashReferenceToken(token);
  const expiresAt = new Date(Date.now() + env.REFERENCE_REQUEST_EXPIRY_DAYS * 24 * 60 * 60 * 1000);

  const inserted = await db.query<ReferenceRequest>(
    `INSERT INTO reference_requests
      (org_id, candidate_id, referee_email, referee_phone, persona_id, question_set_id, status, token, expires_at, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,'PENDING',$7,$8,$9)
     RETURNING *`,
    [
      orgId,
      input.candidate_id,
      input.referee_email ?? null,
      input.referee_phone ?? null,
      input.persona_id ?? null,
      questionSet.question_set_id,
      tokenHash,
      expiresAt.toISOString(),
      actorUserId,
    ]
  );
  const request = inserted.rows[0];

  await logAudit({
    entity_type: "REFERENCE_REQUEST",
    entity_id: request.request_id,
    agent_or_user: actorUserId,
    action: "REFERENCE_REQUEST_CREATED",
    output_value: { candidate_id: input.candidate_id, question_set_id: questionSet.question_set_id, expires_at: request.expires_at },
    reason_code: "REFERENCE_REQUEST_CREATED",
    reason_comment: "Reference check request created for candidate; awaiting delivery to referee.",
  });

  const respondUrl = `${env.APP_PUBLIC_URL}/reference-check/${token}`;
  const questionnaireText = buildQuestionnaireText(candidate.full_name, respondUrl, questionSet.questions);

  let sendStatus: "SENT" | "FAILED";
  let sendError: string | undefined;

  if (input.referee_email) {
    const result = await sendOutboundEmail(orgId, {
      candidate_id: input.candidate_id,
      to: input.referee_email,
      subject: `Reference request for ${candidate.full_name}`,
      body_text: questionnaireText,
      template_code: "REFERENCE_CHECK_REQUEST",
    });
    sendStatus = result.status;
    sendError = result.last_error;
  } else {
    const result = await sendTemplateMessage(orgId, {
      candidate_id: input.candidate_id,
      phone: input.referee_phone as string,
      template_name: "reference_check_request",
      template_params: { candidate_name: candidate.full_name, link: respondUrl },
    });
    sendStatus = result.status;
    sendError = result.last_error;
  }

  if (sendStatus === "SENT") {
    const updated = await db.query<ReferenceRequest>(
      `UPDATE reference_requests SET status='SENT', sent_at=now() WHERE request_id=$1 RETURNING *`,
      [request.request_id]
    );
    await logAudit({
      entity_type: "REFERENCE_REQUEST",
      entity_id: request.request_id,
      agent_or_user: actorUserId,
      action: "REFERENCE_REQUEST_SENT",
      output_value: { channel: input.referee_email ? "EMAIL" : "WHATSAPP" },
      reason_code: "REFERENCE_REQUEST_SENT",
      reason_comment: "Questionnaire delivered to referee.",
    });
    return { request: updated.rows[0], token };
  }

  await logAudit({
    entity_type: "REFERENCE_REQUEST",
    entity_id: request.request_id,
    agent_or_user: actorUserId,
    action: "REFERENCE_REQUEST_SEND_FAILED",
    output_value: { channel: input.referee_email ? "EMAIL" : "WHATSAPP", error: sendError },
    reason_code: "REFERENCE_REQUEST_SEND_FAILED",
    reason_comment: sendError ?? "Delivery to referee failed.",
  });
  throw new Error(`Failed to send reference request: ${sendError ?? "unknown delivery error"}`);
}

// -----------------------------------------------------------------------
// Referee response intake (public, token-authenticated)
// -----------------------------------------------------------------------

export interface ReferenceAnswerInput {
  question_id: string;
  response_text: string;
}

/**
 * POST /api/v1/references/respond/:token — public endpoint. One-time use:
 * a request already COMPLETED/EXPIRED/CANCELLED is rejected with the same
 * generic error as an unknown token, so a resent/reused link cannot be
 * distinguished from an invalid one.
 */
export async function submitReferenceResponses(
  token: string,
  answers: ReferenceAnswerInput[]
): Promise<{ received: true; request_id: string }> {
  const tokenHash = hashReferenceToken(token);

  const requestRes = await db.query<ReferenceRequest>(`SELECT * FROM reference_requests WHERE token=$1`, [tokenHash]);
  if (requestRes.rowCount === 0) {
    throw new ReferenceLinkError();
  }
  const request = requestRes.rows[0];

  if (request.status === "COMPLETED" || request.status === "CANCELLED" || request.status === "EXPIRED") {
    throw new ReferenceLinkError();
  }
  if (new Date(request.expires_at).getTime() < Date.now()) {
    await db.query(`UPDATE reference_requests SET status='EXPIRED' WHERE request_id=$1`, [request.request_id]);
    throw new ReferenceLinkError();
  }

  const questionSetRes = await db.query<ReferenceQuestionSet>(
    `SELECT * FROM reference_question_sets WHERE question_set_id=$1`,
    [request.question_set_id]
  );
  const validIds = new Set((questionSetRes.rows[0]?.questions ?? []).map((q) => q.question_id));
  for (const a of answers) {
    if (!validIds.has(a.question_id)) {
      throw new Error(`Unknown question_id: ${a.question_id}`);
    }
  }

  await db.withTransaction(async (client) => {
    for (const a of answers) {
      await client.query(
        `INSERT INTO reference_responses (request_id, question_id, response_text)
         VALUES ($1,$2,$3)
         ON CONFLICT (request_id, question_id) DO UPDATE SET response_text=EXCLUDED.response_text`,
        [request.request_id, a.question_id, a.response_text]
      );
    }
    await client.query(`UPDATE reference_requests SET status='COMPLETED', completed_at=now() WHERE request_id=$1`, [
      request.request_id,
    ]);
  });

  await logAudit({
    entity_type: "REFERENCE_REQUEST",
    entity_id: request.request_id,
    agent_or_user: "EXTERNAL_REFEREE",
    action: "REFERENCE_RESPONSE_RECEIVED",
    output_value: { answer_count: answers.length },
    reason_code: "REFERENCE_RESPONSE_RECEIVED",
    reason_comment: "Referee submitted responses to the reference questionnaire.",
  });

  return { received: true, request_id: request.request_id };
}

// -----------------------------------------------------------------------
// Deterministic scoring (pure functions — unit tested directly)
// -----------------------------------------------------------------------

/** Scores a single question's response. Pure and deterministic. */
export function scoreQuestionResponse(question: ReferenceQuestion, responseText: string | null | undefined): QuestionScoringOutcome {
  const raw = (responseText ?? "").trim();

  if (raw.length === 0) {
    return {
      question_id: question.question_id,
      score: null,
      confidence: 0,
      reason_code: "REFERENCE_RESPONSE_MISSING",
      reason_description: `No response was provided for question "${question.question_id}".`,
      evidence: { raw_response: responseText ?? null },
    };
  }

  if (question.type === "TEXT") {
    return {
      question_id: question.question_id,
      score: null,
      confidence: null,
      reason_code: "REFERENCE_TEXT_EVIDENCE_ONLY",
      reason_description: "Open-ended response recorded as evidence only; not auto-scored and requires human review.",
      evidence: { raw_response: raw },
    };
  }

  if (question.type === "RATING_1_5") {
    const isValidRating = /^[1-5]$/.test(raw);
    if (!isValidRating) {
      return {
        question_id: question.question_id,
        score: null,
        confidence: 0,
        reason_code: "REFERENCE_RATING_INVALID",
        reason_description: `Response "${raw}" is not a valid 1-5 rating; flagged for human review.`,
        evidence: { raw_response: raw },
      };
    }
    const value = Number(raw);
    return {
      question_id: question.question_id,
      score: value, // raw 1-5; normalized against weight in computeReferenceScoring
      confidence: 1,
      reason_code: "REFERENCE_RATING_SCORED",
      reason_description: `Referee rated ${value}/5.`,
      evidence: { raw_response: raw, parsed_value: value },
    };
  }

  // YES_NO
  const normalized = raw.toUpperCase();
  const isYes = ["YES", "Y", "TRUE"].includes(normalized);
  const isNo = ["NO", "N", "FALSE"].includes(normalized);
  if (!isYes && !isNo) {
    return {
      question_id: question.question_id,
      score: null,
      confidence: 0,
      reason_code: "REFERENCE_YESNO_INVALID",
      reason_description: `Response "${raw}" is not a valid Yes/No answer; flagged for human review.`,
      evidence: { raw_response: raw },
    };
  }
  return {
    question_id: question.question_id,
    score: isYes ? 1 : 0, // fraction; normalized against weight in computeReferenceScoring
    confidence: 1,
    reason_code: "REFERENCE_YESNO_SCORED",
    reason_description: `Referee answered "${isYes ? "Yes" : "No"}".`,
    evidence: { raw_response: raw, parsed_value: isYes ? "YES" : "NO" },
  };
}

/**
 * Aggregates per-question scores into a single deterministic outcome.
 * Weights among scorable (non-TEXT) questions are normalized to a
 * 100-point scale, matching the existing dimension_scoring_agent /
 * persona_agent normalization convention elsewhere in UROS. TEXT
 * questions never contribute to total_score/max_score — they are
 * evidence only and always require a human to actually read them.
 */
export function computeReferenceScoring(
  questions: ReferenceQuestion[],
  responses: Array<{ question_id: string; response_text: string | null }>
): ReferenceScoringOutcome {
  const responseByQuestion = new Map(responses.map((r) => [r.question_id, r.response_text]));
  const scorableQuestions = questions.filter((q) => q.type !== "TEXT");
  const totalWeight = scorableQuestions.reduce((sum, q) => sum + q.weight, 0);

  const perQuestion: QuestionScoringOutcome[] = [];
  let totalScore = 0;
  let anyMissingOrInvalid = false;

  for (const q of questions) {
    const outcome = scoreQuestionResponse(q, responseByQuestion.get(q.question_id) ?? null);

    if (q.type === "TEXT") {
      perQuestion.push(outcome);
      continue;
    }

    const maxPoints = totalWeight > 0 ? (q.weight / totalWeight) * 100 : 0;
    let earnedPoints = 0;
    if (outcome.score === null) {
      anyMissingOrInvalid = true;
    } else if (q.type === "RATING_1_5") {
      earnedPoints = maxPoints * (outcome.score / 5);
    } else {
      earnedPoints = maxPoints * outcome.score; // YES_NO: score is already 0 or 1
    }
    totalScore += earnedPoints;

    perQuestion.push({
      ...outcome,
      evidence: { ...outcome.evidence, weight: q.weight, max_points: maxPoints, earned_points: earnedPoints },
    });
  }

  const maxScore = totalWeight > 0 ? 100 : 0;
  const pct = maxScore > 0 ? (totalScore / maxScore) * 100 : 0;

  let recommendation: ReferenceScoringOutcome["recommendation"];
  let reason_code: string;
  let reason_description: string;

  if (maxScore === 0) {
    recommendation = "NEEDS_REVIEW";
    reason_code = "REFERENCE_NO_SCORABLE_QUESTIONS";
    reason_description = "The question set has no auto-scorable (RATING_1_5/YES_NO) questions; full human review is required.";
  } else if (anyMissingOrInvalid) {
    recommendation = "NEEDS_REVIEW";
    reason_code = "REFERENCE_INCOMPLETE_RESPONSES";
    reason_description = "One or more scorable questions were missing or invalid; human review is required before any decision.";
  } else if (pct >= RECOMMEND_THRESHOLD_PCT) {
    recommendation = "RECOMMEND";
    reason_code = "REFERENCE_SCORE_ABOVE_THRESHOLD";
    reason_description = `Weighted score ${pct.toFixed(1)}/100 meets or exceeds the recommend threshold of ${RECOMMEND_THRESHOLD_PCT}.`;
  } else if (pct < CONCERN_THRESHOLD_PCT) {
    recommendation = "CONCERN";
    reason_code = "REFERENCE_SCORE_BELOW_THRESHOLD";
    reason_description = `Weighted score ${pct.toFixed(1)}/100 is below the concern threshold of ${CONCERN_THRESHOLD_PCT}.`;
  } else {
    recommendation = "NEEDS_REVIEW";
    reason_code = "REFERENCE_SCORE_MID_RANGE";
    reason_description = `Weighted score ${pct.toFixed(1)}/100 falls between the concern (${CONCERN_THRESHOLD_PCT}) and recommend (${RECOMMEND_THRESHOLD_PCT}) thresholds.`;
  }

  return {
    per_question: perQuestion,
    total_score: totalScore,
    max_score: maxScore,
    recommendation,
    reason_code,
    reason_description,
    evidence: {
      total_weight: totalWeight,
      thresholds: { recommend_pct: RECOMMEND_THRESHOLD_PCT, concern_pct: CONCERN_THRESHOLD_PCT },
      question_count: questions.length,
      scorable_question_count: scorableQuestions.length,
    },
  };
}

// -----------------------------------------------------------------------
// Scoring orchestration (I/O) and human review
// -----------------------------------------------------------------------

/**
 * POST /api/v1/references/requests/:request_id/score — persists the
 * deterministic scoring outcome for every response and upserts
 * reference_results. Never touches an existing human review decision on
 * re-run (reviewer_id/review_decision/review_reason/reviewed_at are
 * intentionally excluded from the upsert's SET clause).
 */
export async function runReferenceScoring(requestId: string, orgId: string, actorUserId: string): Promise<ReferenceResult> {
  const requestRes = await db.query<ReferenceRequest>(`SELECT * FROM reference_requests WHERE request_id=$1 AND org_id=$2`, [
    requestId,
    orgId,
  ]);
  if (requestRes.rowCount === 0) {
    throw new Error("Reference request not found");
  }
  const request = requestRes.rows[0];

  if (request.status !== "COMPLETED") {
    throw new Error("Reference request has not received referee responses yet");
  }

  const questionSetRes = await db.query<ReferenceQuestionSet>(
    `SELECT * FROM reference_question_sets WHERE question_set_id=$1`,
    [request.question_set_id]
  );
  const questionSet = questionSetRes.rows[0];

  const responsesRes = await db.query<ReferenceResponseRecord>(
    `SELECT * FROM reference_responses WHERE request_id=$1`,
    [requestId]
  );

  const outcome = computeReferenceScoring(
    questionSet.questions,
    responsesRes.rows.map((r) => ({ question_id: r.question_id, response_text: r.response_text }))
  );

  const result = await db.withTransaction(async (client) => {
    for (const pq of outcome.per_question) {
      await client.query(
        `INSERT INTO reference_responses (request_id, question_id, response_text, score, confidence, reason_code, reason_description, evidence)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (request_id, question_id) DO UPDATE SET
           score=EXCLUDED.score, confidence=EXCLUDED.confidence,
           reason_code=EXCLUDED.reason_code, reason_description=EXCLUDED.reason_description,
           evidence=EXCLUDED.evidence`,
        [
          requestId,
          pq.question_id,
          (pq.evidence as any).raw_response ?? null,
          pq.score,
          pq.confidence,
          pq.reason_code,
          pq.reason_description,
          JSON.stringify(pq.evidence),
        ]
      );
    }

    const resultRes = await client.query<ReferenceResult>(
      `INSERT INTO reference_results
        (request_id, candidate_id, org_id, total_score, max_score, recommendation, reason_code, reason_description, evidence)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (request_id) DO UPDATE SET
         total_score=EXCLUDED.total_score, max_score=EXCLUDED.max_score,
         recommendation=EXCLUDED.recommendation, reason_code=EXCLUDED.reason_code,
         reason_description=EXCLUDED.reason_description, evidence=EXCLUDED.evidence
       RETURNING *`,
      [
        requestId,
        request.candidate_id,
        orgId,
        outcome.total_score,
        outcome.max_score,
        outcome.recommendation,
        outcome.reason_code,
        outcome.reason_description,
        JSON.stringify({ ...outcome.evidence, per_question: outcome.per_question }),
      ]
    );
    return resultRes.rows[0];
  });

  await logAudit({
    entity_type: "REFERENCE_RESULT",
    entity_id: result.result_id,
    agent_or_user: actorUserId,
    action: "REFERENCE_SCORING_COMPLETED",
    input_value: { request_id: requestId },
    output_value: { total_score: outcome.total_score, max_score: outcome.max_score, recommendation: outcome.recommendation },
    reason_code: outcome.reason_code,
    reason_comment: outcome.reason_description,
  });

  return result;
}

export type ReferenceReviewDecisionInput = "APPROVED" | "REJECTED" | "ESCALATED";

/**
 * PATCH /api/v1/references/results/:result_id — the ONLY path by which a
 * reference result is ever treated as finalized. review_reason is
 * mandatory for every decision, not only for overrides of a CONCERN
 * recommendation.
 */
export async function reviewReferenceResult(
  resultId: string,
  orgId: string,
  actorUserId: string,
  decision: ReferenceReviewDecisionInput,
  reason: string
): Promise<ReferenceResult> {
  const existing = await db.query<ReferenceResult>(`SELECT * FROM reference_results WHERE result_id=$1 AND org_id=$2`, [
    resultId,
    orgId,
  ]);
  if (existing.rowCount === 0) {
    throw new Error("Reference result not found");
  }

  const updated = await db.query<ReferenceResult>(
    `UPDATE reference_results
     SET reviewer_id=$1, review_decision=$2, review_reason=$3, reviewed_at=now()
     WHERE result_id=$4
     RETURNING *`,
    [actorUserId, decision, reason, resultId]
  );

  await logAudit({
    entity_type: "REFERENCE_RESULT",
    entity_id: resultId,
    agent_or_user: actorUserId,
    action: `REFERENCE_RESULT_${decision}`,
    input_value: { previous_recommendation: existing.rows[0].recommendation },
    output_value: { review_decision: decision },
    reason_code: `REFERENCE_RESULT_${decision}`,
    reason_comment: reason,
  });

  return updated.rows[0];
}
