/**
 * Per-item error isolation and crash-resumable batches.
 *
 * Two building blocks, both infrastructure — neither knows anything about
 * recruitment semantics:
 *
 *  `runBatchIsolated`   loops over items, catches each item's error, records
 *                       it, optionally flags the item, and carries on. One
 *                       malformed candidate can never abort a 50,000-row
 *                       batch or lose the other 49,999 results.
 *
 *  `runResumableBatch`  the same, plus durable progress in
 *                       `agent_batch_progress` (migration 0028). If the
 *                       process is killed mid-run, a later run with the same
 *                       `batchKey` skips the items already handled and
 *                       finishes the remainder — no duplicated side effects,
 *                       no restart-from-zero.
 *
 * Checkpoint writes are best-effort by design: if `agent_batch_progress` is
 * unavailable (not yet migrated, DB failover in progress) the batch still
 * runs and still isolates per-item errors — it just loses the ability to
 * resume. That trade is logged loudly as
 * AGENT_BATCH_CHECKPOINT_UNAVAILABLE rather than swallowed.
 */
import { db } from "../../database/client";
import { env } from "../../config/env.schema";
import { logger } from "../../utils/logger";
import { logAudit } from "../../utils/audit_helper";
import { metrics } from "../../utils/metrics";
import { getPoolForClass } from "./pools";
import { AgentClass } from "./types";

export type BatchStatus = "RUNNING" | "INTERRUPTED" | "COMPLETED" | "FAILED";

export interface BatchItemFailure<K = string> {
  key: K;
  error: string;
}

export interface BatchItemSuccess<K = string, R = unknown> {
  key: K;
  index: number;
  result: R;
}

export interface BatchProgressRow {
  batch_key: string;
  agent_name: string;
  org_id: string | null;
  status: BatchStatus;
  total_items: number;
  processed_count: number;
  succeeded_count: number;
  failed_count: number;
  resumed_count: number;
  attempts: number;
  processed_keys: string[];
  failures: BatchItemFailure[];
  last_error: string | null;
  actor: string | null;
  request_id: string | null;
  started_at: string;
  heartbeat_at: string;
  completed_at: string | null;
}

export interface IsolatedBatchOptions<T, K = string, R = unknown> {
  /** Registered agent name; used for logging, audit attribution and metrics labels. */
  agentName: string;
  /** Pool class used when `concurrency` > 1. Defaults to "general". */
  agentClass?: AgentClass;
  items: T[];
  /** Stable per-item identity. Must be deterministic across restarts for resume to work. */
  itemKey: (item: T, index: number) => K;
  processItem: (item: T, index: number) => Promise<R>;
  actor?: string;
  request_id?: string;
  entity_type?: string;
  /** Quest 02: tenant scope for audit entries. When provided, audit rows are TENANT-scoped. */
  orgId?: string;
  /** Write one audit_log row per failed item. Default true — UROS audits everything. */
  auditFailures?: boolean;
  /**
   * Optional hook to *flag* the failed item (e.g. set a candidate to
   * NEEDS_REVIEW, or record a processing_error on a sheet row). Errors
   * thrown by the hook are logged, never propagated: flagging must not
   * become a second failure mode.
   */
  onItemFailure?: (key: K, item: T, err: unknown) => Promise<void> | void;
  /**
   * Items processed concurrently. 1 (default) preserves the exact
   * sequential ordering and side-effect interleaving of a plain `for` loop;
   * higher values dispatch through the class worker pool to raise
   * throughput on large batches. Results are always returned in input order.
   */
  concurrency?: number;
}

export interface IsolatedBatchResult<K = string, R = unknown> {
  agent_name: string;
  total: number;
  ok: number;
  failed: number;
  results: BatchItemSuccess<K, R>[];
  failures: BatchItemFailure<K>[];
}

export interface ResumableBatchOptions<T, K = string, R = unknown> extends IsolatedBatchOptions<T, K, R> {
  /** Stable across restarts, e.g. `ELIGIBILITY:<circular_id>:<rule_pack_version_id>`. */
  batchKey: string;
  orgId?: string;
  /** Persist progress every N items. Defaults to AGENT_CHECKPOINT_EVERY. */
  checkpointEvery?: number;
  /**
   * What to do when a stored row for this key is already COMPLETED.
   * Default true: clear the stored progress and run every item again, since
   * re-invoking a finished batch is an explicit operator action (re-evaluate
   * after a rule-pack change, re-send after a fix) and silently doing
   * nothing would be the surprising behaviour. Set false to make the call a
   * no-op that returns the stored summary.
   *
   * Crash recovery is unaffected either way: an interrupted run leaves the
   * row RUNNING or INTERRUPTED, never COMPLETED, so it always resumes.
   */
  rerunCompleted?: boolean;
}

export interface ResumableBatchResult<K = string, R = unknown> extends IsolatedBatchResult<K, R> {
  batch_key: string;
  status: BatchStatus;
  attempts: number;
  /** Items skipped because a previous, interrupted run already handled them. */
  resumed_skipped: number;
  /** True when the stored row was already COMPLETED and nothing was re-run. */
  already_completed: boolean;
  /** True when progress could not be persisted (batch still ran to completion). */
  checkpointing_available: boolean;
}

// ---------------------------------------------------------------------
// Per-item isolation
// ---------------------------------------------------------------------

/**
 * Runs `processItem` for every item, isolating failures per item.
 *
 * Never throws because of an item-level error: the returned summary carries
 * both the successful results and the per-item failure reasons, so the
 * caller decides what to do (report, flag, retry later) instead of losing
 * the whole batch to one bad row.
 */
export async function runBatchIsolated<T, K = string, R = unknown>(
  options: IsolatedBatchOptions<T, K, R>
): Promise<IsolatedBatchResult<K, R>> {
  const {
    agentName,
    agentClass = "general",
    items,
    itemKey,
    processItem,
    actor = agentName,
    request_id: requestId,
    entity_type: entityType = "AGENT_BATCH",
    auditFailures = true,
    onItemFailure,
    concurrency = 1,
    orgId,
  } = options;

  const results: BatchItemSuccess<K, R>[] = new Array(items.length);
  const failures: BatchItemFailure<K>[] = [];
  let okCount = 0;

  const handleOne = async (item: T, index: number): Promise<void> => {
    const key = itemKey(item, index);
    try {
      const result = await processItem(item, index);
      results[index] = { key, index, result };
      okCount += 1;
      metrics.agentBatchItemsTotal.inc({ agent: agentName, status: "ok" });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      failures.push({ key, error: message });
      metrics.agentBatchItemsTotal.inc({ agent: agentName, status: "failed" });
      logger.error("AGENT_BATCH_ITEM_FAILED", {
        agent_name: agentName,
        request_id: requestId,
        item_key: String(key),
        item_index: index,
        error: message,
      });
      if (onItemFailure) {
        try {
          await onItemFailure(key, item, err);
        } catch (flagErr) {
          // Flagging is a courtesy, not part of the batch contract.
          logger.error("AGENT_BATCH_ITEM_FLAG_FAILED", {
            agent_name: agentName,
            item_key: String(key),
            error: flagErr instanceof Error ? flagErr.message : String(flagErr),
          });
        }
      }
      if (auditFailures) {
        await logAudit({
          org_id: orgId,
          entity_type: entityType,
          entity_id: String(key),
          agent_or_user: actor,
          action: "AGENT_BATCH_ITEM_FAILED",
          input_value: { agent_name: agentName, batch_item_index: index, request_id: requestId },
          reason_code: "AGENT_ITEM_ERROR",
          reason_comment: `Batch item failed in isolation; the remaining ${items.length - index - 1} item(s) continued. Error: ${message}`,
        });
      }
    }
  };

  if (concurrency > 1 && items.length > 1) {
    // Dispatch through the class pool: bounded parallelism, so a large batch
    // gets faster without ever opening more DB connections than the pool
    // (and DB_POOL_MAX) allows.
    const pool = getPoolForClass(agentClass);
    const tasks: Array<Promise<void>> = [];
    for (let i = 0; i < items.length; i++) {
      const index = i;
      tasks.push(pool.submit(() => handleOne(items[index], index)).catch(() => undefined));
    }
    await Promise.all(tasks);
  } else {
    for (let i = 0; i < items.length; i++) {
      await handleOne(items[i], i);
    }
  }

  // `results` was pre-sized to items.length; compact out any holes (there
  // should be none — every index is either a success or a recorded failure).
  const compacted = results.filter((r) => r !== undefined);

  logger.info("AGENT_BATCH_COMPLETED", {
    agent_name: agentName,
    request_id: requestId,
    total: items.length,
    ok: okCount,
    failed: failures.length,
  });

  return {
    agent_name: agentName,
    total: items.length,
    ok: okCount,
    failed: failures.length,
    results: compacted,
    failures,
  };
}

// ---------------------------------------------------------------------
// Durable progress (agent_batch_progress)
// ---------------------------------------------------------------------

function toProgressRow(row: any): BatchProgressRow {
  return {
    batch_key: row.batch_key,
    agent_name: row.agent_name,
    org_id: row.org_id ?? null,
    status: row.status,
    total_items: Number(row.total_items ?? 0),
    processed_count: Number(row.processed_count ?? 0),
    succeeded_count: Number(row.succeeded_count ?? 0),
    failed_count: Number(row.failed_count ?? 0),
    resumed_count: Number(row.resumed_count ?? 0),
    attempts: Number(row.attempts ?? 1),
    processed_keys: Array.isArray(row.processed_keys) ? row.processed_keys.map(String) : [],
    failures: Array.isArray(row.failures) ? row.failures : [],
    last_error: row.last_error ?? null,
    actor: row.actor ?? null,
    request_id: row.request_id ?? null,
    started_at: row.started_at,
    heartbeat_at: row.heartbeat_at,
    completed_at: row.completed_at ?? null,
  };
}

/** Reads persisted progress for a batch key, or null when there is none / the table is unavailable. */
export async function loadBatchProgress(batchKey: string): Promise<BatchProgressRow | null> {
  try {
    const res = await db.query(`SELECT * FROM agent_batch_progress WHERE batch_key=$1`, [batchKey]);
    return res.rowCount === 0 ? null : toProgressRow(res.rows[0]);
  } catch (err) {
    logCheckpointUnavailable("load", batchKey, err);
    return null;
  }
}

function logCheckpointUnavailable(op: string, batchKey: string, err: unknown): void {
  logger.error("AGENT_BATCH_CHECKPOINT_UNAVAILABLE", {
    operation: op,
    batch_key: batchKey,
    error: err instanceof Error ? err.message : String(err),
    hint: "Run `npm run migrate` to create agent_batch_progress (migration 0028). The batch continues without resume capability.",
  });
}

/**
 * Runs a checkpoint write, degrading to `fallback` instead of throwing when
 * the progress table is unavailable. The return value is the write's own
 * result, not merely "did not throw", so callers can tell "I persisted this"
 * apart from "there was nothing to persist" — a shutdown log claiming it
 * interrupted a batch that had already finished would be a lie.
 */
async function safeCheckpoint<T>(op: string, batchKey: string, fn: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    logCheckpointUnavailable(op, batchKey, err);
    return fallback;
  }
}

/**
 * Claims (or re-claims) a batch for this process. Returns the row to work
 * from, including any keys already processed by an interrupted run.
 *
 * All prior values are read first and then written back as explicit
 * parameters — the INSERT never sub-selects from its own target table, which
 * keeps the statement valid on every supported Postgres version and makes it
 * straightforward to reproduce in a fake DB.
 */
async function beginBatch<T, K, R>(options: ResumableBatchOptions<T, K, R>): Promise<{
  row: BatchProgressRow | null;
  alreadyCompleted: BatchProgressRow | null;
}> {
  const {
    batchKey,
    agentName,
    orgId,
    items,
    actor = agentName,
    request_id: requestId,
    rerunCompleted = true,
  } = options;

  const existing = await loadBatchProgress(batchKey);

  if (existing && existing.status === "COMPLETED" && !rerunCompleted) {
    return { row: existing, alreadyCompleted: existing };
  }

  // A COMPLETED row is not resume state — re-running it starts clean. Only
  // RUNNING (owner died without a graceful shutdown) and INTERRUPTED (owner
  // shut down cleanly, or the supervisor reclaimed it) carry prior progress.
  const resumeFrom = existing && existing.status !== "COMPLETED" ? existing : null;
  const priorKeys = resumeFrom?.processed_keys ?? [];
  const priorFailures = resumeFrom?.failures ?? [];

  let row: BatchProgressRow | null = null;
  await safeCheckpoint(
    "begin",
    batchKey,
    async () => {
      const res = await db.query(
        `INSERT INTO agent_batch_progress
           (batch_key, agent_name, org_id, status, total_items, processed_count, succeeded_count,
            failed_count, resumed_count, attempts, processed_keys, failures, actor, request_id,
            started_at, heartbeat_at)
         VALUES ($1,$2,$3,'RUNNING',$4,$5,$6,$7,$8,1,$9::jsonb,$10::jsonb,$11,$12,now(),now())
         ON CONFLICT (batch_key) DO UPDATE SET
           agent_name=EXCLUDED.agent_name,
           org_id=COALESCE(EXCLUDED.org_id, agent_batch_progress.org_id),
           status='RUNNING',
           total_items=EXCLUDED.total_items,
           processed_count=EXCLUDED.processed_count,
           succeeded_count=EXCLUDED.succeeded_count,
           failed_count=EXCLUDED.failed_count,
           resumed_count=EXCLUDED.resumed_count,
           attempts=agent_batch_progress.attempts + 1,
           processed_keys=EXCLUDED.processed_keys,
           failures=EXCLUDED.failures,
           actor=EXCLUDED.actor,
           request_id=EXCLUDED.request_id,
           last_error=NULL,
           completed_at=NULL,
           heartbeat_at=now(),
           updated_at=now()
         RETURNING *`,
        [
          batchKey,
          agentName,
          orgId ?? null,
          items.length,
          priorKeys.length,
          resumeFrom?.succeeded_count ?? 0,
          priorFailures.length,
          resumeFrom?.resumed_count ?? 0,
          JSON.stringify(priorKeys),
          JSON.stringify(priorFailures),
          actor,
          requestId ?? null,
        ]
      );
      row = toProgressRow(res.rows[0]);
    },
    undefined
  );

  // If the claim write failed but the read succeeded, keep resuming from what
  // we could read — losing the checkpoint must not lose the progress.
  if (row === null) row = resumeFrom;

  return { row, alreadyCompleted: null };
}

async function persistCheckpoint(
  batchKey: string,
  patch: {
    processed_keys: string[];
    failures: BatchItemFailure[];
    processed_count: number;
    succeeded_count: number;
    failed_count: number;
    resumed_count: number;
    last_error?: string | null;
  }
): Promise<boolean> {
  return safeCheckpoint(
    "checkpoint",
    batchKey,
    async () => {
      await db.query(
        `UPDATE agent_batch_progress
           SET processed_keys=$2::jsonb, failures=$3::jsonb, processed_count=$4,
               succeeded_count=$5, failed_count=$6, resumed_count=$7, last_error=$8,
               heartbeat_at=now(), updated_at=now()
         WHERE batch_key=$1`,
        [
          batchKey,
          JSON.stringify(patch.processed_keys),
          JSON.stringify(patch.failures),
          patch.processed_count,
          patch.succeeded_count,
          patch.failed_count,
          patch.resumed_count,
          patch.last_error ?? null,
        ]
      );
      return true;
    },
    false
  );
}

async function finishBatch(
  batchKey: string,
  status: BatchStatus,
  patch: {
    processed_keys: string[];
    failures: BatchItemFailure[];
    processed_count: number;
    succeeded_count: number;
    failed_count: number;
    resumed_count: number;
    total_items: number;
    last_error?: string | null;
  }
): Promise<boolean> {
  return safeCheckpoint(
    "finish",
    batchKey,
    async () => {
      await db.query(
        `UPDATE agent_batch_progress
           SET status=$2, processed_keys=$3::jsonb, failures=$4::jsonb, processed_count=$5,
               succeeded_count=$6, failed_count=$7, resumed_count=$8, total_items=$9,
               last_error=$10, completed_at=CASE WHEN $2 IN ('COMPLETED','FAILED') THEN now() ELSE completed_at END,
               heartbeat_at=now(), updated_at=now()
         WHERE batch_key=$1`,
        [
          batchKey,
          status,
          JSON.stringify(patch.processed_keys),
          JSON.stringify(patch.failures),
          patch.processed_count,
          patch.succeeded_count,
          patch.failed_count,
          patch.resumed_count,
          patch.total_items,
          patch.last_error ?? null,
        ]
      );
      return true;
    },
    false
  );
}

/**
 * Marks a RUNNING batch INTERRUPTED so the next run resumes it. Used on
 * graceful shutdown. Resolves false when there was no RUNNING row to mark
 * (already finished, or already interrupted), so the shutdown report counts
 * only batches it actually changed.
 */
export async function markBatchInterrupted(batchKey: string, reason: string): Promise<boolean> {
  return safeCheckpoint(
    "interrupt",
    batchKey,
    async () => {
      const res = await db.query(
        `UPDATE agent_batch_progress
         SET status='INTERRUPTED', last_error=$2, heartbeat_at=now(), updated_at=now()
       WHERE batch_key=$1 AND status='RUNNING'`,
        [batchKey, reason]
      );
      return (res?.rowCount ?? 0) > 0;
    },
    false
  );
}

/**
 * Startup recovery: any batch left RUNNING whose heartbeat has gone stale
 * belonged to a process that died without a graceful shutdown. Marking it
 * INTERRUPTED makes it eligible for resume and visible to operators.
 * Returns the number of rows reclaimed.
 */
export async function recoverInterruptedBatches(staleAfterMs: number = env.AGENT_BATCH_STALE_AFTER_MS): Promise<number> {
  try {
    const res = await db.query(
      `UPDATE agent_batch_progress
         SET status='INTERRUPTED',
             last_error=COALESCE(last_error, 'Reclaimed by supervisor: heartbeat older than ' || $1 || 'ms'),
             updated_at=now()
       WHERE status='RUNNING' AND heartbeat_at < now() - ($1 || ' milliseconds')::interval
       RETURNING batch_key, agent_name`,
      [String(staleAfterMs)]
    );
    const reclaimed = res.rows ?? [];
    if (reclaimed.length > 0) {
      logger.warn("AGENT_BATCHES_RECLAIMED", {
        count: reclaimed.length,
        batch_keys: reclaimed.map((r: any) => r.batch_key),
        stale_after_ms: staleAfterMs,
      });
    }
    return reclaimed.length;
  } catch (err) {
    logCheckpointUnavailable("recover", "*", err);
    return 0;
  }
}

// ---------------------------------------------------------------------
// Resumable batch
// ---------------------------------------------------------------------

/**
 * Batch keys a resumable run in *this* process currently owns. The
 * supervisor reads it on SIGTERM/SIGINT so an orderly shutdown can mark
 * those rows INTERRUPTED immediately instead of waiting for the heartbeat
 * to go stale (see ./supervisor.ts).
 */
const activeBatchKeys = new Set<string>();

export function listActiveBatchKeys(): string[] {
  return [...activeBatchKeys];
}

/**
 * `runBatchIsolated` + durable progress.
 *
 * On start it loads any prior progress for `batchKey`; items whose keys are
 * already in `processed_keys` are skipped (counted as `resumed_skipped`), so
 * a batch interrupted by a crash, a deploy, or an OOM completes the
 * remainder instead of repeating side effects already committed.
 *
 * A batch whose stored row is already COMPLETED carries no resume state, so
 * by default it runs again from scratch (`rerunCompleted`, the default:
 * re-invoking a finished batch is an explicit operator action and silently
 * doing nothing would be the surprising behaviour). Pass
 * `rerunCompleted: false` for no-op semantics that return the stored
 * summary. Crash recovery is identical either way — an interrupted run
 * leaves the row RUNNING or INTERRUPTED, never COMPLETED, so it resumes.
 */
export async function runResumableBatch<T, K extends string = string, R = unknown>(
  options: ResumableBatchOptions<T, K, R>
): Promise<ResumableBatchResult<K, R>> {
  activeBatchKeys.add(options.batchKey);
  try {
    return await executeResumableBatch(options);
  } finally {
    activeBatchKeys.delete(options.batchKey);
  }
}

async function executeResumableBatch<T, K extends string = string, R = unknown>(
  options: ResumableBatchOptions<T, K, R>
): Promise<ResumableBatchResult<K, R>> {
  const {
    batchKey,
    agentName,
    items,
    itemKey,
    actor = agentName,
    request_id: requestId,
    checkpointEvery = env.AGENT_CHECKPOINT_EVERY,
    orgId,
  } = options;

  const { row, alreadyCompleted } = await beginBatch(options);

  if (alreadyCompleted) {
    logger.info("AGENT_BATCH_ALREADY_COMPLETED", { batch_key: batchKey, agent_name: agentName });
    return {
      agent_name: agentName,
      total: alreadyCompleted.total_items,
      ok: alreadyCompleted.succeeded_count,
      failed: alreadyCompleted.failed_count,
      results: [],
      failures: alreadyCompleted.failures as BatchItemFailure<K>[],
      batch_key: batchKey,
      status: "COMPLETED",
      attempts: alreadyCompleted.attempts,
      resumed_skipped: alreadyCompleted.processed_count,
      already_completed: true,
      checkpointing_available: true,
    };
  }

  const alreadyProcessed = new Set<string>(row?.processed_keys ?? []);
  const priorFailures: BatchItemFailure[] = (row?.failures ?? []).map((f) => ({ key: String(f.key), error: f.error }));
  // Prior-run tallies are carried forward so the persisted row always
  // describes the whole batch, not just this run's slice of it. The
  // succeeded + failed == processed identity the table's CHECK constraint
  // relies on is preserved by adding this run's counts to the prior ones.
  const priorSucceeded = row?.succeeded_count ?? 0;
  const attempts = row?.attempts ?? 1;
  const resumedCount = alreadyProcessed.size;

  const pending: Array<{ item: T; index: number; key: K }> = [];
  for (let i = 0; i < items.length; i++) {
    const key = itemKey(items[i], i);
    if (alreadyProcessed.has(String(key))) {
      metrics.agentBatchItemsTotal.inc({ agent: agentName, status: "resumed_skipped" });
      continue;
    }
    pending.push({ item: items[i], index: i, key });
  }

  if (resumedCount > 0) {
    logger.info("AGENT_BATCH_RESUMED", {
      batch_key: batchKey,
      agent_name: agentName,
      request_id: requestId,
      attempts,
      already_processed: resumedCount,
      remaining: pending.length,
    });
    await logAudit({
      org_id: orgId,
      entity_type: "AGENT_BATCH",
      entity_id: batchKey,
      agent_or_user: actor,
      action: "AGENT_BATCH_RESUMED",
      input_value: { agent_name: agentName, request_id: requestId, attempt: attempts },
      output_value: { already_processed: resumedCount, remaining: pending.length },
      reason_code: "AGENT_BATCH_RESUMED",
      reason_comment: `Batch '${batchKey}' restarted after an interruption (attempt ${attempts}); ${resumedCount} item(s) already processed were skipped, ${pending.length} remained.`,
    });
  }

  // Carry prior failures forward so the final summary describes the *whole*
  // batch, not only this run's slice of it.
  const failures: BatchItemFailure<K>[] = [...(priorFailures as BatchItemFailure<K>[])];
  const processedKeys: string[] = [...alreadyProcessed];
  const results: BatchItemSuccess<K, R>[] = [];
  let okCount = 0;
  let newFailures = 0;
  let sinceCheckpoint = 0;
  let checkpointingAvailable = row !== null;

  const writeCheckpoint = async (final: boolean): Promise<void> => {
    const patch = {
      processed_keys: processedKeys,
      failures: failures as BatchItemFailure[],
      processed_count: processedKeys.length,
      succeeded_count: priorSucceeded + okCount,
      failed_count: failures.length,
      resumed_count: resumedCount,
      // If a caller re-runs a batch key with a smaller item list than a
      // previous attempt, never report a total below the work already done.
      total_items: Math.max(items.length, processedKeys.length),
    };
    const okWrite = final
      ? await finishBatch(batchKey, "COMPLETED", patch)
      : await persistCheckpoint(batchKey, patch);
    if (!okWrite) checkpointingAvailable = false;
  };

  for (const entry of pending) {
    const { item, index, key } = entry;
    try {
      const result = await options.processItem(item, index);
      results.push({ key, index, result });
      okCount += 1;
      metrics.agentBatchItemsTotal.inc({ agent: agentName, status: "ok" });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      failures.push({ key, error: message });
      newFailures += 1;
      metrics.agentBatchItemsTotal.inc({ agent: agentName, status: "failed" });
      logger.error("AGENT_BATCH_ITEM_FAILED", {
        batch_key: batchKey,
        agent_name: agentName,
        request_id: requestId,
        item_key: String(key),
        item_index: index,
        error: message,
      });
      if (options.onItemFailure) {
        try {
          await options.onItemFailure(key, item, err);
        } catch (flagErr) {
          logger.error("AGENT_BATCH_ITEM_FLAG_FAILED", {
            batch_key: batchKey,
            agent_name: agentName,
            item_key: String(key),
            error: flagErr instanceof Error ? flagErr.message : String(flagErr),
          });
        }
      }
      if (options.auditFailures !== false) {
        await logAudit({
          org_id: orgId,
          entity_type: options.entity_type ?? "AGENT_BATCH",
          entity_id: String(key),
          agent_or_user: actor,
          action: "AGENT_BATCH_ITEM_FAILED",
          input_value: { agent_name: agentName, batch_key: batchKey, batch_item_index: index, request_id: requestId },
          reason_code: "AGENT_ITEM_ERROR",
          reason_comment: `Batch item failed in isolation; the remaining item(s) continued. Error: ${message}`,
        });
      }
    }

    // A failed item is still "processed": it was handled, flagged and
    // reported. Re-running it after a crash could repeat a side effect that
    // already landed, which is worse than reporting it twice.
    processedKeys.push(String(key));
    sinceCheckpoint += 1;
    if (sinceCheckpoint >= checkpointEvery) {
      sinceCheckpoint = 0;
      await writeCheckpoint(false);
    }
  }

  await writeCheckpoint(true);

  await logAudit({
    org_id: orgId,
    entity_type: "AGENT_BATCH",
    entity_id: batchKey,
    agent_or_user: actor,
    action: "AGENT_BATCH_COMPLETED",
    input_value: { agent_name: agentName, request_id: requestId, attempt: attempts },
    output_value: {
      total: items.length,
      ok: okCount,
      failed: failures.length,
      resumed_skipped: resumedCount,
      new_failures_this_run: newFailures,
    },
    reason_code: "AGENT_BATCH_COMPLETED",
    reason_comment: `Batch '${batchKey}' finished: ${okCount} succeeded, ${failures.length} failed in isolation, ${resumedCount} skipped as already processed by an earlier attempt.`,
  });

  logger.info("AGENT_BATCH_COMPLETED", {
    batch_key: batchKey,
    agent_name: agentName,
    request_id: requestId,
    total: items.length,
    ok: okCount,
    failed: failures.length,
    resumed_skipped: resumedCount,
    checkpointing_available: checkpointingAvailable,
  });

  results.sort((a, b) => a.index - b.index);

  return {
    agent_name: agentName,
    total: items.length,
    ok: okCount,
    failed: failures.length,
    results,
    failures,
    batch_key: batchKey,
    status: "COMPLETED",
    attempts,
    resumed_skipped: resumedCount,
    already_completed: false,
    checkpointing_available: checkpointingAvailable,
  };
}
