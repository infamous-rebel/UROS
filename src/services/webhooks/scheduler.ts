import { db } from "../../database/client";
import { env } from "../../config/env.schema";
import { logAudit } from "../../utils/audit_helper";
import { logger } from "../../utils/logger";
import { metrics } from "../../utils/metrics";
import { bootstrapAgentRuntime, installProcessSupervisor } from "../agent_runner/supervisor";

/**
 * Fixed exponential-ish backoff schedule, in milliseconds, indexed by
 * attempt number (1-based): 1m, 5m, 15m, 1h, 6h, 24h. After the 6th
 * attempt fails, the delivery is dead-lettered (status DEAD) rather than
 * retried again — an operator must intervene.
 */
export const BACKOFF_SCHEDULE_MS: readonly number[] = [
  60_000, // 1m
  5 * 60_000, // 5m
  15 * 60_000, // 15m
  60 * 60_000, // 1h
  6 * 60 * 60_000, // 6h
  24 * 60 * 60_000, // 24h
];

/**
 * Returns the delay before the next attempt, given the attempt number
 * about to be scheduled (1-based, i.e. the count *after* the failure
 * that just occurred). Returns `null` once the schedule is exhausted,
 * signaling the caller to dead-letter the delivery instead of retrying.
 */
export function computeNextRetryDelayMs(nextAttemptNumber: number): number | null {
  const index = nextAttemptNumber - 1;
  if (index < 0 || index >= BACKOFF_SCHEDULE_MS.length) return null;
  return BACKOFF_SCHEDULE_MS[index];
}

interface DeliveryRow {
  delivery_id: string;
  org_id: string;
  event_type: string;
  target_url: string;
  payload: unknown;
  status: "PENDING" | "SUCCESS" | "FAILED" | "DEAD";
  attempt_count: number;
  max_attempts: number;
}

async function attemptDelivery(row: DeliveryRow): Promise<void> {
  try {
    const res = await fetch(row.target_url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(row.payload),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`Webhook target responded ${res.status}: ${res.statusText}`);

    await db.query(
      `UPDATE outgoing_webhook_deliveries
       SET status='SUCCESS', delivered_at=now(), attempt_count=attempt_count+1
       WHERE delivery_id=$1`,
      [row.delivery_id]
    );

    await logAudit({
      entity_type: "WEBHOOK_DELIVERY",
      entity_id: row.delivery_id,
      agent_or_user: "WebhookScheduler",
      action: "DELIVERY_SUCCEEDED",
      output_value: { event_type: row.event_type, target_url: row.target_url, attempt: row.attempt_count + 1 },
    });
    metrics.webhookDeliveriesTotal.inc({ status: "success" });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const nextAttempt = row.attempt_count + 1;
    const delay = computeNextRetryDelayMs(nextAttempt);
    const isDead = delay === null;

    await db.query(
      `UPDATE outgoing_webhook_deliveries
       SET attempt_count=$1,
           status=$2,
           last_error=$3,
           next_retry_at = CASE WHEN $4::boolean THEN next_retry_at ELSE now() + ($5 || ' milliseconds')::interval END
       WHERE delivery_id=$6`,
      [nextAttempt, isDead ? "DEAD" : "FAILED", message, isDead, delay ?? 0, row.delivery_id]
    );

    logger.warn("WEBHOOK_DELIVERY_ATTEMPT_FAILED", {
      delivery_id: row.delivery_id,
      attempt: nextAttempt,
      dead_lettered: isDead,
      next_retry_delay_ms: delay,
      error: message,
    });

    await logAudit({
      entity_type: "WEBHOOK_DELIVERY",
      entity_id: row.delivery_id,
      agent_or_user: "WebhookScheduler",
      action: isDead ? "DELIVERY_DEAD_LETTERED" : "DELIVERY_RETRY_SCHEDULED",
      reason_comment: message,
      output_value: { attempt: nextAttempt, next_retry_delay_ms: delay },
    });
    metrics.webhookDeliveriesTotal.inc({ status: isDead ? "dead_lettered" : "retry_scheduled" });
  }
}

/**
 * Claims and processes deliveries due for (re)attempt, using
 * `FOR UPDATE SKIP LOCKED` so multiple scheduler instances (e.g. one per
 * API replica) never double-process the same delivery.
 */
export async function processDueDeliveries(limit: number = 50): Promise<number> {
  const claimed = await db.withTransaction(async (client) => {
    const res = await client.query<DeliveryRow>(
      `SELECT * FROM outgoing_webhook_deliveries
       WHERE status IN ('PENDING','FAILED') AND next_retry_at <= now()
       ORDER BY next_retry_at ASC
       LIMIT $1
       FOR UPDATE SKIP LOCKED`,
      [limit]
    );
    return res.rows;
  });

  for (const row of claimed) {
    // Per-delivery isolation (Agent-Level Hardening): `attemptDelivery`
    // already records its own failures, but if recording itself throws (a
    // connection dropped mid-update) the row is left PENDING/FAILED and the
    // next tick retries it. One bad delivery must never abort the rest of
    // the claimed batch.
    try {
      await attemptDelivery(row);
    } catch (err) {
      logger.error("WEBHOOK_DELIVERY_ISOLATED_FAILURE", {
        delivery_id: row.delivery_id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return claimed.length;
}

let schedulerHandle: NodeJS.Timeout | null = null;

/**
 * Starts the polling loop. Idempotent — calling twice is a no-op.
 *
 * `keepProcessAlive` is for the standalone scheduler process only: an
 * unref'd interval lets Node exit immediately, which under a container
 * `restart` policy presents as an endless instant-exit crash loop.
 */
export function startScheduler(
  intervalMs: number = env.WEBHOOK_SCHEDULER_INTERVAL_MS,
  keepProcessAlive: boolean = false
): void {
  if (schedulerHandle) return;
  logger.info("WEBHOOK_SCHEDULER_STARTED", { intervalMs });
  schedulerHandle = setInterval(() => {
    processDueDeliveries().catch((err) => {
      logger.error("WEBHOOK_SCHEDULER_TICK_FAILED", { error: err instanceof Error ? err.message : String(err) });
    });
  }, intervalMs);
  if (!keepProcessAlive) schedulerHandle.unref();
}

export function stopScheduler(): void {
  if (schedulerHandle) {
    clearInterval(schedulerHandle);
    schedulerHandle = null;
  }
}

if (require.main === module) {
  installProcessSupervisor();
  void bootstrapAgentRuntime()
    .catch((err) => logger.error("AGENT_RUNTIME_BOOTSTRAP_FAILED", { error: String(err) }))
    .finally(() => startScheduler(env.WEBHOOK_SCHEDULER_INTERVAL_MS, true));
}
