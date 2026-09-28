/**
 * Supervisor / process-restart layer.
 *
 * Two complementary mechanisms, because UROS runs both as a container and
 * as a set of long-lived in-process loops:
 *
 *  1. **Container-level** (the real restart policy). `deploy/docker/*` sets
 *     `restart: unless-stopped` and a healthcheck, and the Kubernetes
 *     manifests set `restartPolicy` + liveness/readiness probes on
 *     `/health`. When this process dies, the orchestrator brings it back.
 *     What that guarantees *depends on* persisted state — hence
 *     `agent_batch_progress` (migration 0028) and `recoverInterruptedBatches`.
 *
 *  2. **In-app supervision** for loops that must not take the whole process
 *     down with them (`supervise()` below): a poll worker, a scheduler, a
 *     batch driver. It restarts the task with exponential backoff up to
 *     `AGENT_SUPERVISOR_MAX_RESTARTS`, audits every restart, and then gives
 *     up by exiting non-zero so mechanism 1 takes over. A crash loop that
 *     silently retries forever is worse than a loud exit.
 *
 * Crash recovery contract: on boot, `bootstrapAgentRuntime()` reclaims
 * batches whose heartbeat went stale (their owner died without a graceful
 * shutdown) and re-drives them from persisted progress. On SIGTERM/SIGINT,
 * `gracefulShutdown()` marks this process's in-flight batches INTERRUPTED
 * and drains the worker pools, so a rolling deploy loses at most the one
 * item that was mid-flight — and that item is re-run, not skipped, because
 * it was never checkpointed as processed.
 */
import { env } from "../../config/env.schema";
import { logger } from "../../utils/logger";
import { logAudit } from "../../utils/audit_helper";
import { metrics } from "../../utils/metrics";
import { shutdownAllPools, poolSnapshots } from "./pools";
import { listActiveBatchKeys, markBatchInterrupted, recoverInterruptedBatches } from "./batch";
import { registerAllAgents } from "./agents";

export interface SupervisedTaskOptions {
  name: string;
  /** One full run of the supervised work. Returning normally means "done, stop supervising". */
  run: (attempt: number) => Promise<void>;
  maxRestarts?: number;
  restartBackoffMs?: number;
  /** Exit the process (non-zero) once restarts are exhausted. Default true. */
  exitOnExhaustion?: boolean;
  sleep?: (ms: number) => Promise<void>;
}

export interface SupervisorStats {
  name: string;
  attempts: number;
  restarts: number;
  running: boolean;
  stopped: boolean;
  last_error: string | null;
  started_at: string | null;
  finished_at: string | null;
}

export interface SupervisedTask {
  start(): Promise<void>;
  stop(): void;
  stats(): SupervisorStats;
}

const defaultSleep = (ms: number): Promise<void> => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Wraps a long-running loop so an unexpected throw restarts it instead of
 * killing the process. Deterministic backoff, bounded restarts, every
 * restart audited.
 */
export function supervise(options: SupervisedTaskOptions): SupervisedTask {
  const {
    name,
    run,
    maxRestarts = env.AGENT_SUPERVISOR_MAX_RESTARTS,
    restartBackoffMs = env.AGENT_SUPERVISOR_RESTART_BACKOFF_MS,
    exitOnExhaustion = true,
    sleep = defaultSleep,
  } = options;

  const stats: SupervisorStats = {
    name,
    attempts: 0,
    restarts: 0,
    running: false,
    stopped: false,
    last_error: null,
    started_at: null,
    finished_at: null,
  };

  let stopRequested = false;

  async function loop(): Promise<void> {
    stats.running = true;
    stats.started_at = new Date().toISOString();

    while (!stopRequested) {
      stats.attempts += 1;
      const attempt = stats.attempts;
      try {
        await run(attempt);
        stats.last_error = null;
        stats.running = false;
        stats.finished_at = new Date().toISOString();
        logger.info("SUPERVISED_TASK_COMPLETED", { task: name, attempts: attempt });
        return;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        stats.last_error = message;

        if (stopRequested) break;

        if (stats.restarts >= maxRestarts) {
          stats.running = false;
          stats.finished_at = new Date().toISOString();
          logger.error("SUPERVISED_TASK_GAVE_UP", { task: name, restarts: stats.restarts, error: message });
          await logAudit({
            scope: "SYSTEM",
            entity_type: "SUPERVISOR",
            entity_id: name,
            agent_or_user: "Supervisor",
            action: "SUPERVISED_TASK_GAVE_UP",
            reason_code: "SUPERVISOR_RESTARTS_EXHAUSTED",
            reason_comment: `Task '${name}' failed ${stats.restarts + 1} time(s) and the restart budget (${maxRestarts}) is exhausted. Last error: ${message}`,
          });
          if (exitOnExhaustion) {
            // Loud exit, not a silent dead loop: the container restart policy
            // (mechanism 1) decides what happens next.
            process.exitCode = 1;
            throw err;
          }
          return;
        }

        stats.restarts += 1;
        metrics.supervisorRestartsTotal.inc({ task: name });
        const backoff = Math.min(30_000, restartBackoffMs * Math.pow(2, stats.restarts - 1));
        logger.error("SUPERVISED_TASK_RESTARTING", { task: name, restart: stats.restarts, backoff_ms: backoff, error: message });
        await logAudit({
          scope: "SYSTEM",
          entity_type: "SUPERVISOR",
          entity_id: name,
          agent_or_user: "Supervisor",
          action: "SUPERVISED_TASK_RESTARTED",
          reason_code: "SUPERVISOR_RESTART",
          reason_comment: `Task '${name}' crashed (${message}); restart ${stats.restarts}/${maxRestarts} in ${backoff}ms.`,
        });
        await sleep(backoff);
      }
    }

    stats.running = false;
    stats.finished_at = new Date().toISOString();
  }

  return {
    start: () => loop(),
    stop: () => {
      stopRequested = true;
      stats.stopped = true;
    },
    stats: () => ({ ...stats }),
  };
}

// ---------------------------------------------------------------------
// Process lifecycle
// ---------------------------------------------------------------------

/**
 * Marks every batch this process currently owns as INTERRUPTED so the next
 * run resumes from the last checkpoint rather than waiting for the
 * heartbeat to go stale.
 */
export async function interruptActiveBatches(reason: string): Promise<number> {
  const keys = listActiveBatchKeys();
  let marked = 0;
  for (const key of keys) {
    if (await markBatchInterrupted(key, reason)) marked += 1;
  }
  if (keys.length > 0) {
    logger.warn("AGENT_ACTIVE_BATCHES_INTERRUPTED", { count: keys.length, batch_keys: keys, reason });
  }
  return marked;
}

let shutdownInProgress: Promise<void> | null = null;

/**
 * Orderly teardown: interrupt owned batches, drain worker pools, then let
 * the caller exit. Idempotent — safe to call from several signal handlers.
 */
export async function gracefulShutdown(signal: string, exit: boolean = true): Promise<void> {
  if (shutdownInProgress) return shutdownInProgress;
  shutdownInProgress = (async () => {
    logger.warn("AGENT_RUNTIME_SHUTTING_DOWN", { signal, pools: poolSnapshots() });
    await interruptActiveBatches(`Process received ${signal}`);
    await shutdownAllPools();
    await logAudit({
      scope: "SYSTEM",
      entity_type: "SUPERVISOR",
      entity_id: "agent-runtime",
      agent_or_user: "Supervisor",
      action: "AGENT_RUNTIME_SHUTDOWN",
      reason_code: "GRACEFUL_SHUTDOWN",
      reason_comment: `Agent runtime shut down on ${signal}; in-flight batches marked INTERRUPTED for resume, worker pools drained.`,
    });
    if (exit) process.exit(0);
  })();
  return shutdownInProgress;
}

let bootstrapped = false;

export interface AgentRuntimeBootstrapResult {
  agents_registered: number;
  batches_reclaimed: number;
}

/**
 * One-time process start-up: register every known agent, reclaim batches
 * orphaned by a previous crash, and install signal handlers.
 *
 * Called from `api/server.ts` and `services/queue/consumer.ts` so both the
 * API and worker processes share identical recovery behaviour.
 */
export async function bootstrapAgentRuntime(): Promise<AgentRuntimeBootstrapResult> {
  if (bootstrapped) return { agents_registered: 0, batches_reclaimed: 0 };
  bootstrapped = true;

  const agentsRegistered = registerAllAgents();
  const reclaimed = await recoverInterruptedBatches();

  logger.info("AGENT_RUNTIME_BOOTSTRAPPED", {
    agents_registered: agentsRegistered,
    batches_reclaimed: reclaimed,
    timeout_ms: env.AGENT_TIMEOUT_MS,
    max_retries: env.AGENT_MAX_RETRIES,
    circuit_failure_threshold: env.AGENT_CIRCUIT_FAILURE_THRESHOLD,
    circuit_reset_ms: env.AGENT_CIRCUIT_RESET_MS,
  });

  return { agents_registered: agentsRegistered, batches_reclaimed: reclaimed };
}

let handlersInstalled = false;

/**
 * Installs process-level supervision. Deliberately opt-in (not a module
 * side effect) so tests and short-lived scripts are never surprised by an
 * exit handler.
 */
export function installProcessSupervisor(): void {
  if (handlersInstalled) return;
  handlersInstalled = true;

  process.on("SIGTERM", () => {
    void gracefulShutdown("SIGTERM");
  });
  process.on("SIGINT", () => {
    void gracefulShutdown("SIGINT");
  });

  // An unhandled rejection is a bug, not a transient condition. Log it with
  // full context and let the container restart policy bring the process back
  // to a known-good state; continuing would risk serving decisions from an
  // inconsistent in-memory state.
  process.on("unhandledRejection", (reason) => {
    logger.error("UNHANDLED_REJECTION", {
      error: reason instanceof Error ? reason.message : String(reason),
      stack: reason instanceof Error ? reason.stack : undefined,
    });
    void logAudit({
      scope: "SYSTEM",
      entity_type: "PROCESS",
      entity_id: "uros",
      agent_or_user: "Supervisor",
      action: "UNHANDLED_REJECTION",
      reason_code: "PROCESS_UNSTABLE",
      reason_comment: reason instanceof Error ? reason.message : String(reason),
    });
  });

  process.on("uncaughtException", (err) => {
    logger.error("UNCAUGHT_EXCEPTION", { error: err.message, stack: err.stack });
    void logAudit({
      scope: "SYSTEM",
      entity_type: "PROCESS",
      entity_id: "uros",
      agent_or_user: "Supervisor",
      action: "UNCAUGHT_EXCEPTION",
      reason_code: "PROCESS_UNSTABLE",
      reason_comment: err.message,
    }).finally(() => {
      void gracefulShutdown("uncaughtException", true);
    });
  });
}

/** Test hook: allow `bootstrapAgentRuntime` to run again in a fresh module registry. */
export function resetSupervisorForTests(): void {
  bootstrapped = false;
  handlersInstalled = false;
  shutdownInProgress = null;
}
