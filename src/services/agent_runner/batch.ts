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
 *                       `agent_batch_progress` + `agent_batch_progress_item`
 *                       (migration 0031). If the process is killed mid-run,
 *                       a later run with the same `batchKey` skips the items
 *                       already handled and finishes the remainder — no
 *                       duplicated side effects, no restart-from-zero.
 *
 * Quest 03 redesign: replaced O(n²) JSONB processed_keys/failures array
 * rewrites with per-item INSERTs into agent_batch_progress_item. Added
 * lease-based concurrency protection (lease_expires_at + heartbeat) and
 * fencing tokens to prevent split-brain batch writes after lease expiry.
 *
 * Checkpoint writes are best-effort by design: if the progress tables are
 * unavailable the batch still runs and still isolates per-item errors — it
 * just loses the ability to resume.
 */
import { db } from "../../database/client";
import { env } from "../../config/env.schema";
import { logger } from "../../utils/logger";
import { logAudit } from "../../utils/audit_helper";
import { metrics } from "../../utils/metrics";
import { getPoolForClass } from "./pools";
import { AgentClass } from "./types";
import crypto from "crypto";

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
  resumed_count: number;
  attempts: number;
  owner_id: string | null;
  lease_expires_at: string | null;
  fencing_token: number;
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
  /**
   * What to do when a stored row for this key is already COMPLETED.
   * Default true: clear the stored progress and run every item again, since
   * re-invoking a finished batch is an explicit operator action.
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
 * Never throws because of an item-level error.
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
// Durable progress (agent_batch_progress + agent_batch_progress_item)
// ---------------------------------------------------------------------

function toProgressRow(row: any): BatchProgressRow {
  return {
    batch_key: row.batch_key,
    agent_name: row.agent_name,
    org_id: row.org_id ?? null,
    status: row.status,
    total_items: Number(row.total_items ?? 0),
    resumed_count: Number(row.resumed_count ?? 0),
    attempts: Number(row.attempts ?? 1),
    owner_id: row.owner_id ?? null,
    lease_expires_at: row.lease_expires_at ?? null,
    fencing_token: Number(row.fencing_token ?? 0),
    last_error: row.last_error ?? null,
    actor: row.actor ?? null,
    request_id: row.request_id ?? null,
    started_at: row.started_at,
    heartbeat_at: row.heartbeat_at,
    completed_at: row.completed_at ?? null,
  };
}

/** Reads persisted progress for a batch key, or null when there is none. */
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
    hint: "Run `npm run migrate` to create agent_batch_progress (migration 0031). The batch continues without resume capability.",
  });
}

/**
 * Runs a checkpoint write, degrading to `fallback` instead of throwing when
 * the progress table is unavailable.
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
 * Custom error thrown when a fencing token mismatch is detected.
 * Propagates out of executeResumableBatch to halt batch execution.
 */
export class FencingTokenError extends Error {
  constructor(public batchKey: string, public expected: number, public actual: number) {
    super(`Fencing token mismatch for batch '${batchKey}': expected ${expected}, row has ${actual}`);
    this.name = "FencingTokenError";
  }
}

/**
 * Claims (or re-claims) a batch for this process. Returns the row, the
 * fencing token, and any item keys already processed (from agent_batch_progress_item).
 */
async function beginBatch<T, K, R>(options: ResumableBatchOptions<T, K, R>): Promise<{
  row: BatchProgressRow | null;
  alreadyCompleted: BatchProgressRow | null;
  fencingToken: number;
  alreadyProcessedKeys: Set<string>;
  pastFailures: Array<{ key: string; error: string }>;
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
    return { row: existing, alreadyCompleted: existing, fencingToken: existing.fencing_token, alreadyProcessedKeys: new Set(), pastFailures: [] };
  }

  const ownerId = crypto.randomUUID();
  const leaseMs = env.AGENT_BATCH_LEASE_MS;

  let row: BatchProgressRow | null = null;
  let fencingToken = 0;

  await safeCheckpoint(
    "begin",
    batchKey,
    async () => {
      const res = await db.query(
        `INSERT INTO agent_batch_progress
           (batch_key, agent_name, org_id, status, total_items,
            owner_id, lease_expires_at, fencing_token,
            actor, request_id, started_at, heartbeat_at)
         VALUES ($1, $2, $3, 'RUNNING', $4,
                 $5::uuid, now() + ($6 || ' milliseconds')::interval,
                 COALESCE((SELECT fencing_token FROM agent_batch_progress WHERE batch_key = $1), 0) + 1,
                 $7, $8, now(), now())
         ON CONFLICT (batch_key) DO UPDATE SET
           status = 'RUNNING',
           owner_id = $5::uuid,
           lease_expires_at = now() + ($6 || ' milliseconds')::interval,
           fencing_token = agent_batch_progress.fencing_token + 1,
           attempts = agent_batch_progress.attempts + 1,
           actor = EXCLUDED.actor,
           request_id = EXCLUDED.request_id,
           last_error = NULL,
           completed_at = NULL,
           heartbeat_at = now(),
           updated_at = now()
         RETURNING *`,
        [
          batchKey,
          agentName,
          orgId ?? null,
          items.length,
          ownerId,
          String(leaseMs),
          actor,
          requestId ?? null,
        ]
      );
      row = toProgressRow(res.rows[0]);
      fencingToken = row.fencing_token;
    },
    undefined
  );

  // If the claim write failed but the read succeeded, keep resuming from what
  // we could read — losing the checkpoint must not lose the progress.
  if (row === null) {
    row = existing && existing.status !== "COMPLETED" ? existing : null;
    fencingToken = row?.fencing_token ?? 0;
  }

  // When re-running a COMPLETED batch, clear old per-item progress so items are re-processed.
  const wasCompleted = existing?.status === "COMPLETED" && rerunCompleted;
  if (wasCompleted) {
    try {
      await db.query(`DELETE FROM agent_batch_progress_item WHERE batch_key = $1`, [batchKey]);
    } catch { /* best-effort */ }
  }

  // Read already-processed items from the per-item table (replaces JSONB processed_keys)
  const alreadyProcessedKeys = new Set<string>();
  const pastFailures: Array<{ key: string; error: string }> = [];
  if (row && !wasCompleted) {
    try {
      const itemRes = await db.query<{ item_key: string; status: string; error: string | null }>(
        `SELECT item_key, status, error FROM agent_batch_progress_item WHERE batch_key = $1`,
        [batchKey]
      );
      for (const r of itemRes.rows) {
        // Both PROCESSED and FAILED items are skipped on resume:
        // a failed item was already handled, flagged, and reported.
        alreadyProcessedKeys.add(r.item_key);
        if (r.status === "FAILED" && r.error) {
          pastFailures.push({ key: r.item_key, error: r.error });
        }
      }
    } catch (err) {
      logCheckpointUnavailable("read_items", batchKey, err);
    }
  }

  return { row, alreadyCompleted: null, fencingToken, alreadyProcessedKeys, pastFailures };
}

/**
 * Per-item checkpoint: INSERT into agent_batch_progress_item.
 * Called after every item (success → PROCESSED, failure → FAILED).
 * O(1) per item, not O(n) like the old JSONB array rewrite.
 */
async function writeItemCheckpoint(
  batchKey: string,
  itemKey: string,
  status: "PROCESSED" | "FAILED",
  error: string | null = null
): Promise<void> {
  try {
    await db.query(
      `INSERT INTO agent_batch_progress_item (batch_key, item_key, status, error)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (batch_key, item_key) DO UPDATE
         SET status = EXCLUDED.status,
             error = EXCLUDED.error,
             processed_at = now()`,
      [batchKey, itemKey, status, error]
    );
  } catch (err) {
    logCheckpointUnavailable("write_item", batchKey, err);
  }
}

/**
 * Final batch status write. Carries fencing to prevent a reclaimed process
 * from marking the batch complete.
 */
async function finishBatch(
  batchKey: string,
  status: BatchStatus,
  fencingToken: number
): Promise<boolean> {
  return safeCheckpoint(
    "finish",
    batchKey,
    async () => {
      const res = await db.query(
        `UPDATE agent_batch_progress
           SET status = $2,
               completed_at = CASE WHEN $2 IN ('COMPLETED','FAILED') THEN now() ELSE completed_at END,
               heartbeat_at = now(),
               lease_expires_at = NULL,
               updated_at = now()
         WHERE batch_key = $1
           AND fencing_token = $3`,
        [batchKey, status, fencingToken]
      );
      return (res?.rowCount ?? 0) > 0;
    },
    false
  );
}

/**
 * Reads derived counts from agent_batch_progress_item.
 */
async function readBatchCounts(batchKey: string): Promise<{
  processed_count: number;
  succeeded_count: number;
  failed_count: number;
}> {
  try {
    const res = await db.query<{
      processed_count: string;
      succeeded_count: string;
      failed_count: string;
    }>(
      `SELECT
         COUNT(*) AS processed_count,
         COUNT(*) FILTER (WHERE status = 'PROCESSED') AS succeeded_count,
         COUNT(*) FILTER (WHERE status = 'FAILED') AS failed_count
       FROM agent_batch_progress_item
       WHERE batch_key = $1`,
      [batchKey]
    );
    return {
      processed_count: Number(res.rows[0]?.processed_count ?? 0),
      succeeded_count: Number(res.rows[0]?.succeeded_count ?? 0),
      failed_count: Number(res.rows[0]?.failed_count ?? 0),
    };
  } catch {
    return { processed_count: 0, succeeded_count: 0, failed_count: 0 };
  }
}

/**
 * Starts a heartbeat interval that refreshes the batch lease.
 * Returns a cleanup function. Caller MUST invoke in BOTH success and
 * failure paths (typically in a `finally` block).
 */
function startHeartbeat(batchKey: string, leaseMs: number, heartbeatMs: number): () => void {
  const interval = setInterval(async () => {
    try {
      await db.query(
        `UPDATE agent_batch_progress
            SET lease_expires_at = now() + ($2 || ' milliseconds')::interval,
                heartbeat_at = now()
          WHERE batch_key = $1 AND status = 'RUNNING'`,
        [batchKey, String(leaseMs)]
      );
    } catch (err) {
      logger.error("HEARTBEAT_FAILED", {
        batch_key: batchKey,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }, heartbeatMs);

  return () => clearInterval(interval);
}

/**
 * Marks a RUNNING batch INTERRUPTED so the next run resumes it. Used on
 * graceful shutdown. No fencing check — the owning process always has the
 * current token on SIGTERM.
 */
export async function markBatchInterrupted(batchKey: string, reason: string): Promise<boolean> {
  return safeCheckpoint(
    "interrupt",
    batchKey,
    async () => {
      const res = await db.query(
        `UPDATE agent_batch_progress
         SET status='INTERRUPTED', lease_expires_at=NULL, last_error=$2, updated_at=now()
       WHERE batch_key=$1 AND status='RUNNING'`,
        [batchKey, reason]
      );
      return (res?.rowCount ?? 0) > 0;
    },
    false
  );
}

/**
 * Startup recovery: any batch left RUNNING whose lease has expired belonged
 * to a process that died without a graceful shutdown. Marking it
 * INTERRUPTED makes it eligible for resume. Returns the number reclaimed.
 *
 * Quest 03: no longer takes a staleAfterMs parameter. Recovery uses
 * lease_expires_at < now() directly — the lease IS the threshold.
 */
export async function recoverInterruptedBatches(): Promise<number> {
  try {
    const res = await db.query(
      `UPDATE agent_batch_progress
         SET status='INTERRUPTED',
             owner_id = NULL,
             lease_expires_at = NULL,
             fencing_token = fencing_token + 1,
             last_error = COALESCE(last_error, 'Reclaimed by supervisor: lease expired'),
             updated_at=now()
       WHERE status='RUNNING' AND lease_expires_at < now()
       RETURNING batch_key, agent_name, fencing_token`,
      []
    );
    const reclaimed = res.rows ?? [];
    if (reclaimed.length > 0) {
      logger.warn("AGENT_BATCHES_RECLAIMED", {
        count: reclaimed.length,
        batch_keys: reclaimed.map((r: any) => r.batch_key),
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
 * those rows INTERRUPTED immediately instead of waiting for the lease to
 * expire (see ./supervisor.ts).
 */
const activeBatchKeys = new Set<string>();

export function listActiveBatchKeys(): string[] {
  return [...activeBatchKeys];
}

/**
 * `runBatchIsolated` + durable progress with lease/fencing protection.
 *
 * On start it loads any prior progress for `batchKey` from
 * agent_batch_progress_item; items whose keys are already there are
 * skipped (counted as `resumed_skipped`), so a batch interrupted by a
 * crash, deploy, or OOM completes the remainder instead of repeating side
 * effects already committed.
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
    orgId,
  } = options;

  const { row, alreadyCompleted, fencingToken, alreadyProcessedKeys, pastFailures } = await beginBatch(options);

  if (alreadyCompleted) {
    logger.info("AGENT_BATCH_ALREADY_COMPLETED", { batch_key: batchKey, agent_name: agentName });
    const counts = await readBatchCounts(batchKey);
    return {
      agent_name: agentName,
      total: alreadyCompleted.total_items,
      ok: counts.succeeded_count,
      failed: counts.failed_count,
      results: [],
      failures: [],
      batch_key: batchKey,
      status: "COMPLETED",
      attempts: alreadyCompleted.attempts,
      resumed_skipped: counts.processed_count,
      already_completed: true,
      checkpointing_available: true,
    };
  }

  const attempts = row?.attempts ?? 1;
  const resumedCount = alreadyProcessedKeys.size;

  // Build the pending list: items not yet in agent_batch_progress_item
  const pending: Array<{ item: T; index: number; key: K }> = [];
  for (let i = 0; i < items.length; i++) {
    const key = itemKey(items[i], i);
    if (alreadyProcessedKeys.has(String(key))) {
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
    // Persist resumed_count on the batch row for observability.
    await safeCheckpoint("update_resumed_count", batchKey, async () => {
      await db.query(
        `UPDATE agent_batch_progress SET resumed_count = $2, updated_at = now() WHERE batch_key = $1`,
        [batchKey, resumedCount]
      );
    }, undefined);
  }

  const failures: BatchItemFailure<K>[] = [];
  const results: BatchItemSuccess<K, R>[] = [];
  let okCount = 0;
  let newFailures = 0;
  let checkpointingAvailable = row !== null;
  let currentFencingToken = fencingToken;

  // Start heartbeat — MUST be cleared in finally block
  const stopHeartbeat = startHeartbeat(batchKey, env.AGENT_BATCH_LEASE_MS, env.AGENT_BATCH_HEARTBEAT_MS);

  try {
    for (const entry of pending) {
      const { item, index, key } = entry;
      try {
        const result = await options.processItem(item, index);
        results.push({ key, index, result });
        okCount += 1;
        metrics.agentBatchItemsTotal.inc({ agent: agentName, status: "ok" });

        // Per-item checkpoint: O(1) INSERT, not O(n) JSONB rewrite
        await writeItemCheckpoint(batchKey, String(key), "PROCESSED");
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

        // Per-item failure checkpoint
        await writeItemCheckpoint(batchKey, String(key), "FAILED", message);

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
    }

    // Final batch status write with fencing
    const okWrite = await finishBatch(batchKey, "COMPLETED", currentFencingToken);
    if (!okWrite && row !== null) {
      checkpointingAvailable = false;
      logger.error("AGENT_BATCH_FENCING_MISMATCH", {
        batch_key: batchKey,
        fencing_token: currentFencingToken,
        operation: "finishBatch",
      });
      await logAudit({
        org_id: orgId,
        entity_type: "AGENT_BATCH",
        entity_id: batchKey,
        agent_or_user: "SYSTEM",
        action: "FENCING_TOKEN_MISMATCH",
        reason_code: "FENCING_TOKEN_MISMATCH",
        reason_comment: `finishBatch fencing mismatch for batch '${batchKey}' (token ${currentFencingToken}); batch may have been reclaimed.`,
      });
      throw new FencingTokenError(batchKey, currentFencingToken, -1);
    }
  } finally {
    // ALWAYS clear heartbeat on BOTH success and failure paths
    stopHeartbeat();
  }

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

  // Merge failures carried forward from a previous attempt (resume scenario).
  for (const pf of pastFailures) {
    failures.push({ key: pf.key as unknown as K, error: pf.error });
  }

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
