import { Queue } from "bullmq";
import { db } from "../../database/client";
import { env } from "../../config/env.schema";
import { logAudit } from "../../utils/audit_helper";
import { logger } from "../../utils/logger";
import { metrics } from "../../utils/metrics";
import { EvaluationJobPayload, EvaluationJobRecord, EnqueueResult } from "./types";

// Quest 01: renamed from "uros:evaluation-jobs" — BullMQ rejects colons
// in queue names (QueueBase constructor throws). Hyphenated form is
// namespace-safe and validated by the broker at construction time.
export const EVALUATION_QUEUE_NAME = "uros-evaluation-jobs";

let bullQueue: Queue | null = null;

function getBullQueue(): Queue {
  if (!env.REDIS_URL) {
    throw new Error("REDIS_URL is not configured; cannot use BullMQ backend");
  }
  if (!bullQueue) {
    bullQueue = new Queue(EVALUATION_QUEUE_NAME, { connection: { url: env.REDIS_URL } as any });
  }
  return bullQueue;
}

/** Postgres unique_violation error code. */
const PG_UNIQUE_VIOLATION = "23505";

function toRecord(row: any): EvaluationJobRecord {
  return {
    job_id: row.job_id,
    batch_id: row.batch_id,
    circular_id: row.circular_id,
    rule_pack_version_id: row.rule_pack_version_id,
    org_id: row.org_id,
    stage: row.stage,
    requested_by: row.requested_by,
    status: row.status,
    error: row.error,
    created_at: row.created_at,
    started_at: row.started_at,
    completed_at: row.completed_at,
  };
}

/**
 * Enqueues an evaluation job. Idempotent per (circular_id,
 * rule_pack_version_id, stage): if an active (QUEUED/PROCESSING) job
 * already exists for that triple, the existing job is returned instead
 * of creating a duplicate — enforced at the database layer by the
 * `uq_active_evaluation_job` partial unique index (migration 0007), so
 * the guarantee holds even under concurrent submissions from multiple
 * API instances, not just within a single process.
 */
export async function enqueueEvaluationJob(payload: EvaluationJobPayload): Promise<EnqueueResult> {
  const insertResult = await tryInsertJob(payload);
  if (insertResult) {
    if (env.REDIS_URL) {
      await getBullQueue().add("run-evaluation", { job_id: insertResult.job_id }, { jobId: insertResult.job_id });
    }
    await logAudit({
      org_id: payload.org_id,
      entity_type: "EVALUATION_JOB",
      entity_id: insertResult.job_id,
      agent_or_user: payload.requested_by,
      action: "JOB_ENQUEUED",
      output_value: payload,
    });
    metrics.evaluationJobsTotal.inc({ status: "queued" });
    return { job: insertResult, deduplicated: false };
  }

  // Insert hit the unique constraint — fetch and return the existing active job.
  const existing = await db.query(
    `SELECT * FROM evaluation_jobs
     WHERE circular_id=$1 AND rule_pack_version_id=$2 AND stage=$3
       AND status IN ('QUEUED','PROCESSING')
     LIMIT 1`,
    [payload.circular_id, payload.rule_pack_version_id, payload.stage]
  );

  if (existing.rowCount === 0) {
    // Extremely rare race: constraint fired but the row is now gone
    // (completed between insert attempt and this select). Retry once.
    return enqueueEvaluationJob(payload);
  }

  logger.info("EVALUATION_JOB_DEDUPLICATED", {
    circular_id: payload.circular_id,
    rule_pack_version_id: payload.rule_pack_version_id,
    stage: payload.stage,
    existing_job_id: existing.rows[0].job_id,
  });
  metrics.evaluationJobsTotal.inc({ status: "deduplicated" });

  return { job: toRecord(existing.rows[0]), deduplicated: true };
}

async function tryInsertJob(payload: EvaluationJobPayload): Promise<EvaluationJobRecord | null> {
  try {
    const result = await db.query(
      `INSERT INTO evaluation_jobs
        (batch_id, circular_id, rule_pack_version_id, org_id, stage, requested_by, status)
       VALUES ($1,$2,$3,$4,$5,$6,'QUEUED')
       RETURNING *`,
      [payload.batch_id, payload.circular_id, payload.rule_pack_version_id, payload.org_id, payload.stage, payload.requested_by]
    );
    return toRecord(result.rows[0]);
  } catch (err: any) {
    if (err?.code === PG_UNIQUE_VIOLATION) {
      return null;
    }
    throw err;
  }
}

export async function getJobStatus(jobId: string): Promise<EvaluationJobRecord | null> {
  const res = await db.query(`SELECT * FROM evaluation_jobs WHERE job_id=$1`, [jobId]);
  return res.rowCount === 0 ? null : toRecord(res.rows[0]);
}
