/**
 * The generic agent runner.
 *
 * One wrapper, applied to every agent, providing:
 *   1. a per-invocation timeout (AGENT_TIMEOUT_MS, overridable per agent),
 *   2. bounded retry with exponential backoff for *transient* failures only,
 *   3. a per-agent circuit breaker (open -> half-open probe -> close),
 *   4. structured logging carrying request_id + agent_name,
 *   5. an audit entry for start, success, failure, retry and circuit change.
 *
 * Cost on the happy path: one map lookup, one breaker state check, one
 * `setTimeout` that is cleared immediately, and the audit writes UROS
 * already requires for every action. No polling, no background timers, no
 * wrapper allocations per attempt. Resilience machinery (backoff sleeps,
 * probes, rejections) only activates once something has actually failed.
 *
 * Nothing here knows what an agent *does*. `TInput`/`TOutput` are opaque,
 * so any current or future agent stack plugs in by registering a handler.
 */
import { randomUUID } from "crypto";
import { env } from "../../config/env.schema";
import { logger } from "../../utils/logger";
import { logAudit } from "../../utils/audit_helper";
import { metrics } from "../../utils/metrics";
import { getAgent, hasAgent } from "./registry";
import { getOrCreateAgentState, AgentRuntimeState } from "./agent_state";
import { getPoolForClass } from "./pools";
import {
  AgentCircuitOpenError,
  AgentInvocationContext,
  AgentNotRegisteredError,
  AgentRegistration,
  AgentRunnerOptions,
  AgentTimeoutError,
  computeBackoffMs,
  isTransientError,
} from "./types";

/**
 * Overridable seams, exposed so tests can drive retry/backoff paths in
 * microseconds instead of real seconds. Production code never touches
 * these; the defaults are the real implementations.
 */
export const runnerInternals = {
  sleep: (ms: number): Promise<void> => new Promise<void>((resolve) => setTimeout(resolve, ms)),
  now: (): number => Date.now(),
};

/** Env-derived defaults, re-read per invocation so a config reload/test override takes effect immediately. */
export function defaultRunnerOptions(): AgentRunnerOptions {
  return {
    timeout_ms: env.AGENT_TIMEOUT_MS,
    max_retries: env.AGENT_MAX_RETRIES,
    backoff_base_ms: env.AGENT_BACKOFF_BASE_MS,
    backoff_max_ms: env.AGENT_BACKOFF_MAX_MS,
    circuit_failure_threshold: env.AGENT_CIRCUIT_FAILURE_THRESHOLD,
    circuit_reset_ms: env.AGENT_CIRCUIT_RESET_MS,
    audit: env.AGENT_AUDIT_ENABLED,
  };
}

function resolveOptions(registration: AgentRegistration<any, any>): AgentRunnerOptions {
  return { ...defaultRunnerOptions(), ...(registration.options ?? {}) };
}

/**
 * Races `task` against a timer. The timer is always cleared, so a
 * successful invocation leaves nothing pending.
 *
 * The abandoned task's later rejection is explicitly swallowed: Node would
 * otherwise treat it as an unhandled rejection and tear the process down
 * for a failure we have already reported as a timeout. The work itself is
 * not cancellable from JS — this is a deadline on *waiting*, not a kill.
 */
async function withTimeout<T>(task: Promise<T>, ms: number, agentName: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const guarded = Promise.resolve(task);
  guarded.catch(() => undefined);
  try {
    return await Promise.race([
      guarded,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new AgentTimeoutError(agentName, ms)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function auditIfEnabled(
  enabled: boolean,
  entry: Parameters<typeof logAudit>[0]
): Promise<void> {
  if (!enabled) return;
  await logAudit(entry);
}

/**
 * Registers the built-in catalogue on first use, so a caller gets full
 * resilience with zero set-up — it never has to remember to bootstrap.
 *
 * The `require` is deliberate rather than stylistic: `agents.ts` delegates
 * to the agent modules, and keeping that edge lazy means the runner can be
 * imported from anywhere (including from an agent's own module) without
 * creating a load-time cycle.
 */
function ensureRegistered(agentName: string): void {
  if (hasAgent(agentName)) return;
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const catalogue = require("./agents") as typeof import("./agents");
  catalogue.registerAllAgents();
}

/**
 * Executes the registered agent `agentName` with full resilience applied.
 *
 * Throws the agent's own error when it fails permanently, `AgentTimeoutError`
 * when every attempt exceeded the deadline, or `AgentCircuitOpenError` when
 * the breaker is open and the call was rejected without touching the agent.
 */
export async function runAgent<TInput = unknown, TOutput = unknown>(
  agentName: string,
  input: TInput,
  ctx: AgentInvocationContext = {}
): Promise<TOutput> {
  ensureRegistered(agentName);
  const registration = getAgent<TInput, TOutput>(agentName);
  if (!registration) throw new AgentNotRegisteredError(agentName);
  return executeRegistration(registration, input, ctx);
}

/**
 * Same as `runAgent`, but the invocation is dispatched through the worker
 * pool for the agent's class. Use this for background/batch work so a slow
 * agent can never occupy the request path; the returned promise settles
 * whenever a pool worker finishes, and the pool applies backpressure when
 * its queue is full.
 */
export function enqueueAgent<TInput = unknown, TOutput = unknown>(
  agentName: string,
  input: TInput,
  ctx: AgentInvocationContext = {}
): Promise<TOutput> {
  ensureRegistered(agentName);
  const registration = getAgent<TInput, TOutput>(agentName);
  if (!registration) return Promise.reject(new AgentNotRegisteredError(agentName));
  return getPoolForClass(registration.agent_class).submit(() => executeRegistration(registration, input, ctx));
}

async function executeRegistration<TInput, TOutput>(
  registration: AgentRegistration<TInput, TOutput>,
  input: TInput,
  ctx: AgentInvocationContext
): Promise<TOutput> {
  const { name: agentName, agent_class: agentClass } = registration;
  const options = resolveOptions(registration);
  const state = getOrCreateAgentState(agentName, agentClass);
  // Keep the breaker aligned with current config (env may have been
  // re-validated/overridden since the agent was first registered).
  state.circuit.reconfigure({
    failureThreshold: options.circuit_failure_threshold,
    resetMs: options.circuit_reset_ms,
  });

  const requestId = ctx.request_id ?? randomUUID();
  const actor = ctx.actor ?? agentName;
  const entityType = ctx.entity_type ?? "AGENT";
  const entityId = ctx.entity_id ?? agentName;
  const classifyTransient = registration.isTransient ?? isTransientError;
  const baseMeta = {
    request_id: requestId,
    agent_name: agentName,
    agent_class: agentClass,
    entity_type: entityType,
    entity_id: entityId,
    ...(ctx.meta ?? {}),
  };

  state.invocations += 1;
  state.in_flight += 1;
  const startedAt = runnerInternals.now();

  await auditIfEnabled(options.audit, {
    entity_type: entityType,
    entity_id: entityId,
    agent_or_user: actor,
    action: "AGENT_INVOCATION_STARTED",
    input_value: { agent_name: agentName, agent_class: agentClass, request_id: requestId, ...(ctx.meta ?? {}) },
  });
  logger.debug("AGENT_INVOCATION_STARTED", baseMeta);

  try {
    return await attemptLoop(registration, input, ctx, options, state, {
      requestId,
      actor,
      entityType,
      entityId,
      baseMeta,
      classifyTransient,
      startedAt,
    });
  } finally {
    state.in_flight -= 1;
    state.last_duration_ms = runnerInternals.now() - startedAt;
    metrics.agentDurationMs.observe({ agent: agentName, agent_class: agentClass }, state.last_duration_ms);
  }
}

interface AttemptContext {
  requestId: string;
  actor: string;
  entityType: string;
  entityId: string;
  baseMeta: Record<string, unknown>;
  classifyTransient: (err: unknown) => boolean;
  startedAt: number;
}

async function attemptLoop<TInput, TOutput>(
  registration: AgentRegistration<TInput, TOutput>,
  input: TInput,
  ctx: AgentInvocationContext,
  options: AgentRunnerOptions,
  state: AgentRuntimeState,
  ac: AttemptContext
): Promise<TOutput> {
  const { name: agentName, agent_class: agentClass } = registration;
  let lastError: unknown;
  let timedOutAttempts = 0;
  // Attempts actually made, not the budget. A permanent failure on the first
  // attempt must be recorded as one attempt: an audit row claiming three
  // would mislead the human reviewing it into hunting a retry that never
  // happened.
  let attemptsUsed = 0;

  for (let attempt = 0; attempt <= options.max_retries; attempt++) {
    // ---- circuit gate (checked per attempt, not once per invocation) ----
    const gate = state.circuit.allowRequest();
    if (!gate.allowed) {
      state.last_outcome = "circuit_open";
      state.last_failure_at = new Date(runnerInternals.now()).toISOString();
      state.last_error = `circuit OPEN; retry after ~${gate.retryAfterMs}ms`;
      metrics.agentInvocationsTotal.inc({ agent: agentName, agent_class: agentClass, outcome: "circuit_open" });
      logger.warn("AGENT_INVOCATION_REJECTED_CIRCUIT_OPEN", {
        ...ac.baseMeta,
        retry_after_ms: gate.retryAfterMs,
        attempt,
      });
      await auditIfEnabled(options.audit, {
        entity_type: ac.entityType,
        entity_id: ac.entityId,
        agent_or_user: ac.actor,
        action: "AGENT_CIRCUIT_REJECTED",
        input_value: { agent_name: agentName, request_id: ac.requestId, attempt },
        reason_code: "AGENT_CIRCUIT_OPEN",
        reason_comment: `Invocation rejected without calling the agent: circuit OPEN, probe allowed in ~${gate.retryAfterMs}ms.`,
      });
      throw new AgentCircuitOpenError(agentName, gate.retryAfterMs);
    }

    // ---- one attempt ----
    attemptsUsed += 1;
    try {
      const output = await withTimeout(registration.handler(input, ctx), options.timeout_ms, agentName);

      state.circuit.recordSuccess();
      state.successes += 1;
      state.last_outcome = "success";
      state.last_success_at = new Date(runnerInternals.now()).toISOString();
      state.last_error = null;
      metrics.agentSuccessesTotal.inc({ agent: agentName, agent_class: agentClass });
      metrics.agentInvocationsTotal.inc({ agent: agentName, agent_class: agentClass, outcome: "success" });
      // Success is logged at debug, not info: a single batch can be tens of
      // thousands of invocations, and the durable record of a success is the
      // audit row plus the counters below. Failures stay loud.
      logger.debug("AGENT_INVOCATION_SUCCEEDED", { ...ac.baseMeta, attempt, duration_ms: runnerInternals.now() - ac.startedAt });
      await auditIfEnabled(options.audit, {
        entity_type: ac.entityType,
        entity_id: ac.entityId,
        agent_or_user: ac.actor,
        action: "AGENT_INVOCATION_SUCCEEDED",
        input_value: { agent_name: agentName, request_id: ac.requestId, attempts_used: attempt + 1 },
        output_value: { duration_ms: runnerInternals.now() - ac.startedAt },
        reason_code: "AGENT_OK",
      });
      return output;
    } catch (err) {
      lastError = err;
      const isTimeout = err instanceof AgentTimeoutError;
      if (isTimeout) {
        timedOutAttempts += 1;
        state.timeouts += 1;
        metrics.agentTimeoutsTotal.inc({ agent: agentName, agent_class: agentClass });
      }
      state.circuit.recordFailure();

      const transient = ac.classifyTransient(err);
      const canRetry = transient && attempt < options.max_retries;
      const message = err instanceof Error ? err.message : String(err);

      logger.warn("AGENT_INVOCATION_ATTEMPT_FAILED", {
        ...ac.baseMeta,
        attempt,
        transient,
        will_retry: canRetry,
        timeout: isTimeout,
        error: message,
      });

      if (!canRetry) break;

      state.retries += 1;
      metrics.agentRetriesTotal.inc({ agent: agentName, agent_class: agentClass });
      const backoffMs = computeBackoffMs(attempt, options.backoff_base_ms, options.backoff_max_ms);
      await auditIfEnabled(options.audit, {
        entity_type: ac.entityType,
        entity_id: ac.entityId,
        agent_or_user: ac.actor,
        action: "AGENT_INVOCATION_RETRY",
        input_value: { agent_name: agentName, request_id: ac.requestId, attempt, next_attempt: attempt + 1 },
        reason_code: isTimeout ? "AGENT_TIMEOUT" : "AGENT_TRANSIENT_FAILURE",
        reason_comment: `Attempt ${attempt + 1} failed (${message}); classified transient, retrying in ${backoffMs}ms.`,
      });
      if (backoffMs > 0) await runnerInternals.sleep(backoffMs);
    }
  }

  // ---- permanent failure ----
  const message = lastError instanceof Error ? lastError.message : String(lastError);
  state.failures += 1;
  state.last_outcome = lastError instanceof AgentTimeoutError ? "timeout" : "failure";
  state.last_failure_at = new Date(runnerInternals.now()).toISOString();
  state.last_error = message;
  metrics.agentFailuresTotal.inc({ agent: agentName, agent_class: agentClass });
  metrics.agentInvocationsTotal.inc({
    agent: agentName,
    agent_class: agentClass,
    outcome: lastError instanceof AgentTimeoutError ? "timeout" : "failure",
  });
  logger.error("AGENT_INVOCATION_FAILED", {
    ...ac.baseMeta,
    attempts: attemptsUsed,
    max_attempts: options.max_retries + 1,
    timeouts: timedOutAttempts,
    error: message,
    stack: lastError instanceof Error ? lastError.stack : undefined,
  });
  await auditIfEnabled(options.audit, {
    entity_type: ac.entityType,
    entity_id: ac.entityId,
    agent_or_user: ac.actor,
    action: "AGENT_INVOCATION_FAILED",
    input_value: { agent_name: agentName, request_id: ac.requestId, attempts: attemptsUsed, max_attempts: options.max_retries + 1 },
    reason_code: lastError instanceof AgentTimeoutError ? "AGENT_TIMEOUT" : "AGENT_FAILURE",
    reason_comment: message,
  });

  throw lastError instanceof Error ? lastError : new Error(message);
}
