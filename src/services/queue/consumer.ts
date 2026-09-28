import { Worker } from "bullmq";
import { db } from "../../database/client";
import { env } from "../../config/env.schema";
import { logger } from "../../utils/logger";
import { logAudit } from "../../utils/audit_helper";
import { metrics } from "../../utils/metrics";
import { runEvaluationPipeline } from "../orchestrator/pipeline";
import { EVALUATION_QUEUE_NAME } from "./producer";
import {
  bootstrapAgentRuntime,
  installProcessSupervisor,
  supervise,
  SupervisedTask,
} from "../agent_runner/supervisor";

/**
 * Executes the actual evaluation work for a job. Shared by both the
 * Postgres poll worker and the BullMQ worker so behavior is identical
 * regardless of backend.
 */
async function processJob(jobId: string): Promise<void> {
  const jobRes = await db.query(`SELECT * FROM evaluation_jobs WHERE job_id=$1`, [jobId]);
  if (jobRes.rowCount === 0) {
    logger.warn("EVALUATION_JOB_NOT_FOUND", { jobId });
    return;
  }
  const job = jobRes.rows[0];

  await db.query(`UPDATE evaluation_jobs SET status='PROCESSING', started_at=now() WHERE job_id=$1`, [jobId]);

  try {
    // Quest 01: replaced direct stageEligibility/stageScoringAndRanking calls
    // with runEvaluationPipeline — consistent scoping, audit, and a single
    // entry point behind the queue job type.
    await runEvaluationPipeline({
      batchId: job.batch_id,
      orgId: job.org_id,
      rulePackVersionId: job.rule_pack_version_id,
      circularId: job.circular_id,
      stage: job.stage,
      triggeredBy: "QueueConsumer",
    });

    await db.query(`UPDATE evaluation_jobs SET status='COMPLETED', completed_at=now() WHERE job_id=$1`, [jobId]);
    await logAudit({
      org_id: job.org_id,
      entity_type: "EVALUATION_JOB",
      entity_id: jobId,
      agent_or_user: "QueueConsumer",
      action: "JOB_COMPLETED",
      output_value: { stage: job.stage },
    });
    metrics.evaluationJobsTotal.inc({ status: "completed" });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await db.query(`UPDATE evaluation_jobs SET status='FAILED', error=$1, completed_at=now() WHERE job_id=$2`, [
      message,
      jobId,
    ]);
    await logAudit({
      org_id: job.org_id,
      entity_type: "EVALUATION_JOB",
      entity_id: jobId,
      agent_or_user: "QueueConsumer",
      action: "JOB_FAILED",
      reason_comment: message,
    });
    metrics.evaluationJobsTotal.inc({ status: "failed" });
    logger.error("EVALUATION_JOB_FAILED", { jobId, error: message });
  }
}

/**
 * Postgres-backed poll worker (used when REDIS_URL is not configured).
 * Claims one QUEUED job atomically using `FOR UPDATE SKIP LOCKED` so
 * multiple worker processes can run concurrently without double-processing
 * the same job — this is the concurrency-safety guarantee independent of
 * the idempotency guarantee in `producer.ts` (which prevents *duplicate*
 * jobs; this prevents the *same* job being claimed twice).
 */
export async function claimAndProcessNextJob(): Promise<boolean> {
  const claimed = await db.withTransaction(async (client) => {
    const res = await client.query(
      `SELECT job_id FROM evaluation_jobs
       WHERE status='QUEUED'
       ORDER BY created_at ASC
       LIMIT 1
       FOR UPDATE SKIP LOCKED`
    );
    if (res.rowCount === 0) return null;

    const jobId = res.rows[0].job_id;
    await client.query(`UPDATE evaluation_jobs SET status='PROCESSING', started_at=now() WHERE job_id=$1`, [jobId]);
    return jobId as string;
  });

  if (!claimed) return false;
  await processJob(claimed);
  return true;
}

/**
 * Simple poll loop entry point for the Postgres-backed fallback worker.
 * Returns only if the loop is stopped; a throw means the loop died.
 */
export async function startPollWorker(intervalMs: number = 3_000, shouldStop: () => boolean = () => false): Promise<void> {
  logger.info("EVALUATION_POLL_WORKER_STARTED", { intervalMs });
  while (!shouldStop()) {
    const processed = await claimAndProcessNextJob();
    if (!processed) {
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }
  logger.info("EVALUATION_POLL_WORKER_STOPPED", { intervalMs });
}

/** BullMQ worker entry point (used when REDIS_URL is configured). */
export function startBullWorker(): Worker {
  if (!env.REDIS_URL) {
    throw new Error("REDIS_URL is not configured; cannot start BullMQ worker");
  }
  const worker = new Worker(
    EVALUATION_QUEUE_NAME,
    async (job) => {
      await processJob(job.data.job_id);
    },
    { connection: { url: env.REDIS_URL } as any }
  );
  worker.on("failed", (job, err) => {
    logger.error("BULLMQ_JOB_FAILED", { jobId: job?.id, error: err.message });
  });
  return worker;
}

if (require.main === module) {
  // Agent-Level Hardening: the worker process is supervised the same way as
  // the API process — agents registered, orphaned batches reclaimed, SIGTERM
  // draining work in progress, and the poll loop restarted by the in-app
  // supervisor (bounded, audited) before the container restart policy is
  // ever needed.
  installProcessSupervisor();

  bootstrapAgentRuntime()
    .then(() => {
      if (env.REDIS_URL) {
        startBullWorker();
        return;
      }
      let pollTask: SupervisedTask | null = null;
      pollTask = supervise({
        name: "evaluation-poll-worker",
        run: () => startPollWorker(3_000, () => pollTask?.stats().stopped === true),
      });
      pollTask.start().catch((err) => {
        logger.error("POLL_WORKER_CRASHED", { error: err instanceof Error ? err.message : String(err) });
        process.exit(1);
      });
    })
    .catch((err) => {
      logger.error("AGENT_RUNTIME_BOOTSTRAP_FAILED", { error: err instanceof Error ? err.message : String(err) });
      process.exit(1);
    });
}
