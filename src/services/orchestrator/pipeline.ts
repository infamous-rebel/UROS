/**
 * Orchestrator pipeline.
 *
 * Agent-Level Hardening: every agent call below goes through `runAgent`, and
 * every per-candidate loop goes through `runResumableBatch` /
 * `runBatchIsolated`. The pipeline itself holds no resilience logic — it
 * only names the work and supplies a stable batch key, so:
 *   - one malformed candidate is logged, flagged for human review and
 *     skipped; the remaining candidates in the same stage still run;
 *   - a crash, a deploy or an OOM mid-stage resumes from the persisted
 *     checkpoint instead of repeating side effects already committed;
 *   - timeout / retry / circuit breaking / audit / metrics are inherited
 *     from the runner, not re-implemented here.
 *
 * Stage semantics, gate ordering and human-in-the-loop checkpoints are
 * unchanged: agents still only recommend, humans still decide.
 */
import { db } from "../../database/client";
import { logAudit } from "../../utils/audit_helper";
import { Rule } from "../../models/rule.model";
import { Candidate } from "../../models/candidate.model";
import { Batch } from "../../agents/intake_agent";
import { RawApplicationDocument, ParsedCandidate } from "../../agents/parser_agent";
import { EligibilityRecommendation } from "../../agents/eligibility_agent";
import { ScoringOutcome } from "../../agents/scoring_agent";
import { VerificationOutcome } from "../../agents/verification_agent";
import { waitForHumanGate } from "./hil_gates";
import { logger } from "../../utils/logger";
import { AGENT_NAMES } from "../agent_runner/agents";
import { runAgent } from "../agent_runner/runner";
import { runBatchIsolated, runResumableBatch } from "../agent_runner/batch";

async function logStage(batchId: string, stage: string, meta: Record<string, unknown> = {}) {
  await logAudit({
    entity_type: "PIPELINE_STAGE",
    entity_id: batchId,
    agent_or_user: "Orchestrator",
    action: `STAGE_${stage}`,
    output_value: meta,
  });
  logger.info(`pipeline stage: ${stage}`, { batchId, ...meta });
}

/**
 * Flags a candidate whose stage work failed, for a human to look at. The
 * isolation contract is "log, flag, continue" — flagging routes to the
 * HIL Supervisor, which only writes a review-queue audit entry and never
 * takes a decision on the candidate's behalf.
 */
async function flagForReview(candidateId: string, reason: string): Promise<void> {
  await runAgent<{ candidate_id: string; reason: string }, void>(
    AGENT_NAMES.HIL_SUPERVISOR_ENQUEUE_REVIEW,
    { candidate_id: candidateId, reason },
    { actor: "Orchestrator", entity_type: "CANDIDATE", entity_id: candidateId }
  );
}

export async function stageIntake(batchId: string, orgId: string): Promise<RawApplicationDocument[]> {
  const batch = await runAgent<{ batch_id: string; org_id: string }, Batch>(
    AGENT_NAMES.INTAKE_FETCH_BATCH,
    { batch_id: batchId, org_id: orgId },
    { actor: "Orchestrator", entity_type: "BATCH", entity_id: batchId }
  );
  if (!batch.source.preApprovedAutoIngest) {
    await waitForHumanGate(batchId, "IMPORT_APPROVAL", orgId);
  }
  const documents = await runAgent<{ batch: Batch }, RawApplicationDocument[]>(
    AGENT_NAMES.INTAKE_LOAD_CANDIDATES,
    { batch },
    { actor: "Orchestrator", entity_type: "BATCH", entity_id: batchId }
  );
  await logStage(batchId, "INTAKE", { count: documents.length });
  return documents;
}

export async function stageParse(batchId: string, documents: RawApplicationDocument[]): Promise<void> {
  const summary = await runResumableBatch<RawApplicationDocument>({
    batchKey: `PARSE:${batchId}`,
    agentName: AGENT_NAMES.PARSER_EXTRACT_FIELDS,
    agentClass: "parser",
    orgId: documents[0]?.org_id,
    items: documents,
    itemKey: (doc, index) => doc.candidate_id || `index:${index}`,
    actor: "Orchestrator",
    entity_type: "BATCH",
    processItem: async (doc) => {
      const parsed = await runAgent<{ document: RawApplicationDocument }, ParsedCandidate>(
        AGENT_NAMES.PARSER_EXTRACT_FIELDS,
        { document: doc },
        { actor: "Orchestrator", entity_type: "CANDIDATE", entity_id: doc.candidate_id }
      );
      await runAgent<{ candidate: ParsedCandidate }, void>(
        AGENT_NAMES.PARSER_PERSIST_CANDIDATE,
        { candidate: parsed },
        { actor: "Orchestrator", entity_type: "CANDIDATE", entity_id: parsed.candidate_id }
      );
      if (parsed.hasLowConfidenceFields() || parsed.hasMissingMandatoryFields()) {
        await flagForReview(parsed.candidate_id, "PARSE_REVIEW");
      }
    },
    onItemFailure: (key) => flagForReview(String(key), "PARSE_ERROR"),
  });
  await logStage(batchId, "PARSE", {
    count: documents.length,
    ok: summary.ok,
    failed: summary.failed,
    resumed_skipped: summary.resumed_skipped,
  });
}

export async function stageEligibility(
  batchId: string,
  circularId: string,
  rulePackVersionId: string,
  orgId: string
): Promise<void> {
  const candidatesRes = await db.query<Candidate>(
    `SELECT * FROM candidates WHERE job_circular_id=$1 AND org_id=$2`,
    [circularId, orgId]
  );

  const summary = await runResumableBatch<Candidate>({
    batchKey: `ELIGIBILITY:${batchId}:${circularId}:${rulePackVersionId}`,
    agentName: AGENT_NAMES.ELIGIBILITY_RUN_FOR_CANDIDATE,
    agentClass: "scoring",
    orgId,
    items: candidatesRes.rows,
    itemKey: (candidate) => candidate.candidate_id,
    actor: "Orchestrator",
    entity_type: "BATCH",
    processItem: async (candidate) => {
      const recommendation = await runAgent<
        { candidate: Candidate; rule_pack_version_id: string; actor?: string },
        EligibilityRecommendation
      >(
        AGENT_NAMES.ELIGIBILITY_RUN_FOR_CANDIDATE,
        { candidate, rule_pack_version_id: rulePackVersionId, actor: "EligibilityAgent" },
        { actor: "Orchestrator", entity_type: "CANDIDATE", entity_id: candidate.candidate_id }
      );
      const nextStatus = recommendation.status === "NEEDS_REVIEW" ? "NEEDS_REVIEW" : "ELIGIBILITY_DONE";
      await db.query(
        `UPDATE candidates SET status=$1, updated_at=now() WHERE candidate_id=$2`,
        [nextStatus, candidate.candidate_id]
      );
      if (recommendation.status === "NEEDS_REVIEW") {
        await flagForReview(candidate.candidate_id, "ELIGIBILITY_BORDERLINE");
      }
    },
    // A candidate the agent could not evaluate is never silently dropped:
    // it is flagged for a human and the loop continues with the next one.
    onItemFailure: (key) => flagForReview(String(key), "ELIGIBILITY_ERROR"),
  });

  await logStage(batchId, "ELIGIBILITY", {
    candidates: candidatesRes.rowCount,
    ok: summary.ok,
    failed: summary.failed,
    resumed_skipped: summary.resumed_skipped,
  });
  await waitForHumanGate(batchId, "ELIGIBILITY_REVIEW", orgId);
}

export async function stageScoringAndRanking(batchId: string, rulePackVersionId: string, orgId: string): Promise<void> {
  const scoringRulesRes = await db.query<Rule>(
    `SELECT * FROM rules WHERE rule_pack_version_id=$1 AND rule_type='SCORING' AND active=true`,
    [rulePackVersionId]
  );

  // Quest 01: scope by batch's circular + org (previously only filtered by org_id).
  // Resolve the circular from the batch's candidates.
  const circularRes = await db.query<{ job_circular_id: string }>(
    `SELECT DISTINCT job_circular_id FROM candidates WHERE org_id=$1 AND status IN ('ELIGIBLE_APPROVED','ELIGIBILITY_DONE') LIMIT 1`,
    [orgId]
  );
  const circularId = circularRes.rows[0]?.job_circular_id;

  const eligibleRes = await db.query<Candidate>(
    `SELECT * FROM candidates WHERE status IN ('ELIGIBLE_APPROVED','ELIGIBILITY_DONE') AND org_id=$1${circularId ? ' AND job_circular_id=$2' : ''}`,
    circularId ? [orgId, circularId] : [orgId]
  );

  const summary = await runResumableBatch<Candidate>({
    batchKey: `SCORING:${batchId}:${rulePackVersionId}`,
    agentName: AGENT_NAMES.SCORING_COMPUTE,
    agentClass: "scoring",
    orgId,
    items: eligibleRes.rows,
    itemKey: (candidate) => candidate.candidate_id,
    actor: "Orchestrator",
    entity_type: "BATCH",
    processItem: async (candidate) => {
      const { score, breakdown } = await runAgent<
        { candidate: Candidate; rules: Rule[] },
        ScoringOutcome
      >(
        AGENT_NAMES.SCORING_COMPUTE,
        { candidate, rules: scoringRulesRes.rows },
        { actor: "Orchestrator", entity_type: "CANDIDATE", entity_id: candidate.candidate_id }
      );
      // Quest 01: ON CONFLICT upsert using the unique index from migration 0029.
      await db.query(
        `INSERT INTO scoring_results (candidate_id, rule_pack_version_id, total_score, breakdown)
         VALUES ($1,$2,$3,$4)
         ON CONFLICT (candidate_id, rule_pack_version_id)
         DO UPDATE SET total_score=$3, breakdown=$4, computed_at=now()`,
        [candidate.candidate_id, rulePackVersionId, score, JSON.stringify(breakdown)]
      );
      await db.query(
        `UPDATE candidates SET status='SCORED', updated_at=now() WHERE candidate_id=$1`,
        [candidate.candidate_id]
      );
    },
    onItemFailure: (key) => flagForReview(String(key), "SCORING_ERROR"),
  });

  // Quest 01: pass orgId to rankAndDedupe for proper scoping.
  await runAgent<{ batch_id: string; org_id: string }, void>(
    AGENT_NAMES.RANKING_RANK_AND_DEDUPE,
    { batch_id: batchId, org_id: orgId },
    { actor: "Orchestrator", entity_type: "BATCH", entity_id: batchId }
  );
  await logStage(batchId, "SCORING_RANKING", {
    count: eligibleRes.rowCount,
    ok: summary.ok,
    failed: summary.failed,
    resumed_skipped: summary.resumed_skipped,
  });
}

export async function stageHumanReview(batchId: string, orgId: string): Promise<Candidate[]> {
  await runAgent<{ batch_id: string }, void>(
    AGENT_NAMES.HIL_SUPERVISOR_BUILD_REVIEW_QUEUE,
    { batch_id: batchId },
    { actor: "Orchestrator", entity_type: "BATCH", entity_id: batchId }
  );
  const payload = await waitForHumanGate(batchId, "SHORTLIST_CONFIRMATION", orgId);
  const shortlist = (payload as Candidate[]) ?? [];
  // A human-confirmed payload, not machine work: isolating per candidate is
  // enough, there is no crash-resume semantics to preserve (the gate itself
  // is the durable record of the decision).
  const summary = await runBatchIsolated<Candidate>({
    agentName: "orchestrator.shortlist_update",
    items: shortlist,
    itemKey: (c) => c.candidate_id,
    actor: "Orchestrator",
    request_id: batchId,
    entity_type: "BATCH",
    processItem: async (c) => {
      await db.query(
        `UPDATE candidates SET status='SHORTLISTED', updated_at=now() WHERE candidate_id=$1`,
        [c.candidate_id]
      );
    },
  });
  await logStage(batchId, "HUMAN_REVIEW", {
    shortlisted: shortlist.length,
    ok: summary.ok,
    failed: summary.failed,
  });
  return shortlist;
}

export async function stageVerification(batchId: string, shortlist: Candidate[], orgId: string): Promise<void> {
  const summary = await runResumableBatch<Candidate>({
    batchKey: `VERIFICATION:${batchId}`,
    agentName: AGENT_NAMES.VERIFICATION_CHECK,
    agentClass: "verification",
    orgId,
    items: shortlist,
    itemKey: (c) => c.candidate_id,
    actor: "Orchestrator",
    entity_type: "BATCH",
    processItem: async (c) => {
      const vResult = await runAgent<{ candidate: Candidate; sources: string[] }, VerificationOutcome>(
        AGENT_NAMES.VERIFICATION_CHECK,
        { candidate: c, sources: ["EDUCATION_BOARD", "CIB", "POLICE"] },
        { actor: "Orchestrator", entity_type: "CANDIDATE", entity_id: c.candidate_id }
      );
      await db.query(
        `INSERT INTO verification_results (candidate_id, source, status, details)
         VALUES ($1,$2,$3,$4)`,
        [c.candidate_id, vResult.source, vResult.status, JSON.stringify(vResult.details)]
      );
      if (vResult.status === "Failed" || vResult.status === "Manual Review") {
        await flagForReview(c.candidate_id, "VERIFICATION_ISSUE");
      }
    },
    onItemFailure: (key) => flagForReview(String(key), "VERIFICATION_ERROR"),
  });
  await logStage(batchId, "VERIFICATION", {
    count: shortlist.length,
    ok: summary.ok,
    failed: summary.failed,
    resumed_skipped: summary.resumed_skipped,
  });
  await waitForHumanGate(batchId, "VERIFICATION_SIGNOFF", orgId);
}

export async function stageCommunication(batchId: string, orgId: string): Promise<void> {
  const payload = await waitForHumanGate(batchId, "COMMUNICATION_APPROVAL", orgId);
  const recipients = (payload as Candidate[]) ?? [];
  // A pipeline batch is always scoped to a single organization, so every
  // recipient shares the same org_id — used to resolve the org's default
  // communication language (Feature 5) if a recipient has no personal
  // preferred_language set.
  if (recipients.length > 0) {
    await runAgent<
      { recipients: Candidate[]; template_code: string; channel: "SMS"; org_id: string },
      void
    >(
      AGENT_NAMES.COMMUNICATION_SEND_BATCH,
      {
        recipients,
        template_code: "POST_VERIFICATION",
        channel: "SMS",
        org_id: recipients[0].org_id,
      },
      { actor: "Orchestrator", entity_type: "BATCH", entity_id: batchId }
    );
  }
  await logStage(batchId, "COMMUNICATION", { recipients: recipients.length });
}

export async function stageFinalApproval(batchId: string, triggeredBy: string, orgId: string): Promise<void> {
  const payload = await waitForHumanGate(batchId, "FINAL_APPROVAL", orgId);
  const finalApproved = (payload as Candidate[]) ?? [];
  const summary = await runBatchIsolated<Candidate>({
    agentName: "orchestrator.final_approval_update",
    items: finalApproved,
    itemKey: (c) => c.candidate_id,
    actor: triggeredBy,
    request_id: batchId,
    entity_type: "BATCH",
    processItem: async (c) => {
      await db.query(
        `UPDATE candidates SET status='SELECTED', updated_at=now() WHERE candidate_id=$1`,
        [c.candidate_id]
      );
    },
  });
  if (summary.failed > 0) {
    // Selection is a human decision already taken at the gate; a write that
    // failed must be visible, not absorbed. Loud log, no silent short-list.
    logger.error("PIPELINE_FINAL_APPROVAL_PARTIAL", {
      batchId,
      selected: summary.ok,
      failed: summary.failed,
      failures: summary.failures,
    });
  }
  await logAudit({
    entity_type: "BATCH",
    entity_id: batchId,
    agent_or_user: triggeredBy,
    action: "FINAL_APPROVAL",
    output_value: { selected: finalApproved.length, persisted: summary.ok, failed: summary.failed },
  });
}

export async function runPipeline(
  batchId: string,
  circularId: string,
  rulePackVersionId: string,
  orgId: string,
  triggeredBy: string
): Promise<void> {
  const candidates = await stageIntake(batchId, orgId);
  await stageParse(batchId, candidates);
  await stageEligibility(batchId, circularId, rulePackVersionId, orgId);
  await stageScoringAndRanking(batchId, rulePackVersionId, orgId);
  const shortlist = await stageHumanReview(batchId, orgId);
  await stageVerification(batchId, shortlist, orgId);
  await stageCommunication(batchId, orgId);
  await stageFinalApproval(batchId, triggeredBy, orgId);
}

/**
 * Quest 01: Evaluation pipeline entry point for the queue consumer.
 * Runs eligibility and/or scoring+ranking stages based on the `stage` parameter,
 * scoped to the batch's org + circular. Replaces direct calls to individual
 * stage functions in the consumer, ensuring consistent scoping and audit.
 */
export async function runEvaluationPipeline(params: {
  batchId: string;
  orgId: string;
  rulePackVersionId: string;
  circularId: string;
  stage: "ELIGIBILITY" | "SCORING" | "BOTH";
  triggeredBy: string;
}): Promise<void> {
  const { batchId, orgId, rulePackVersionId, circularId, stage, triggeredBy } = params;

  await logAudit({
    entity_type: "EVALUATION_PIPELINE",
    entity_id: batchId,
    agent_or_user: triggeredBy,
    action: "PIPELINE_STARTED",
    input_value: { stage, circularId, rulePackVersionId, orgId },
  });

  if (stage === "ELIGIBILITY" || stage === "BOTH") {
    await stageEligibility(batchId, circularId, rulePackVersionId, orgId);
  }
  if (stage === "SCORING" || stage === "BOTH") {
    await stageScoringAndRanking(batchId, rulePackVersionId, orgId);
  }

  await logAudit({
    entity_type: "EVALUATION_PIPELINE",
    entity_id: batchId,
    agent_or_user: triggeredBy,
    action: "PIPELINE_COMPLETED",
    output_value: { stage, orgId },
  });
}
