/**
 * Shared vocabulary for the generic agent runner.
 *
 * These types describe *how* an agent is executed (timeout, retry,
 * circuit breaking, pool class), never *what* it decides. Business logic
 * stays in `src/agents/**` untouched; this module only wraps it.
 */

/**
 * Coarse execution class used to size worker pools. A class groups agents
 * with similar resource profiles (OCR/CPU-bound, DB-bound, outbound-I/O
 * bound) so one pool's saturation cannot starve an unrelated stage.
 */
export type AgentClass =
  | "intake"
  | "parser"
  | "scanner"
  | "scoring"
  | "verification"
  | "communication"
  | "analytics"
  | "general";

export const AGENT_CLASSES: readonly AgentClass[] = [
  "intake",
  "parser",
  "scanner",
  "scoring",
  "verification",
  "communication",
  "analytics",
  "general",
] as const;

export type CircuitState = "CLOSED" | "HALF_OPEN" | "OPEN";

/** Terminal outcome of one runner invocation, used for metrics labels. */
export type InvocationOutcome = "success" | "failure" | "timeout" | "circuit_open";

/** Everything the runner needs to correlate an invocation with the outside world. */
export interface AgentInvocationContext {
  /** Correlates with `req.requestId` (see api/middleware/request_id.ts). Generated when absent. */
  request_id?: string;
  /** Human or system actor to attribute the audit entry to. Defaults to the agent name. */
  actor?: string;
  /** Optional subject of the invocation, recorded in the audit trail. */
  entity_type?: string;
  entity_id?: string;
  /** Free-form operational metadata. Never inspected by business logic. */
  meta?: Record<string, unknown>;
}

/** Resolved, per-invocation resilience settings. */
export interface AgentRunnerOptions {
  timeout_ms: number;
  max_retries: number;
  backoff_base_ms: number;
  backoff_max_ms: number;
  circuit_failure_threshold: number;
  circuit_reset_ms: number;
  audit: boolean;
}

/** Overrides applied on top of the env-derived defaults for one registration. */
export type AgentRunnerOverrides = Partial<AgentRunnerOptions>;

/**
 * An agent as the runner sees it: a name, a pool class, and an async
 * handler. `TInput`/`TOutput` are opaque to the runner — it never reads
 * them, which is what lets a future multi-agent stack plug into the same
 * runner without the runner changing.
 */
export interface AgentRegistration<TInput = unknown, TOutput = unknown> {
  name: string;
  agent_class: AgentClass;
  handler: (input: TInput, ctx: AgentInvocationContext) => Promise<TOutput>;
  options?: AgentRunnerOverrides;
  /** Optional predicate overriding the default transient-error classifier for this agent only. */
  isTransient?: (err: unknown) => boolean;
}

/** Raised when an invocation exceeds `timeout_ms`. Always classified transient. */
export class AgentTimeoutError extends Error {
  readonly code = "AGENT_TIMEOUT";
  readonly retryable = true;
  constructor(
    public readonly agent_name: string,
    public readonly timeout_ms: number
  ) {
    super(`Agent '${agent_name}' exceeded its ${timeout_ms}ms timeout`);
    this.name = "AgentTimeoutError";
  }
}

/** Raised when a call is rejected because the agent's circuit is OPEN. Never retried. */
export class AgentCircuitOpenError extends Error {
  readonly code = "AGENT_CIRCUIT_OPEN";
  readonly retryable = false;
  constructor(
    public readonly agent_name: string,
    public readonly retry_after_ms: number
  ) {
    super(
      `Agent '${agent_name}' circuit is OPEN after repeated failures; call rejected. Probe allowed in ~${retry_after_ms}ms.`
    );
    this.name = "AgentCircuitOpenError";
  }
}

/** Raised when `runAgent` is called with a name that was never registered. */
export class AgentNotRegisteredError extends Error {
  readonly code = "AGENT_NOT_REGISTERED";
  readonly retryable = false;
  constructor(public readonly agent_name: string) {
    super(`No agent registered under the name '${agent_name}'`);
    this.name = "AgentNotRegisteredError";
  }
}

/** Raised by a worker pool that has hit its configured queue ceiling (backpressure, not a bug). */
export class PoolSaturatedError extends Error {
  readonly code = "AGENT_POOL_SATURATED";
  readonly retryable = true;
  constructor(
    public readonly pool: string,
    public readonly max_queue_depth: number
  ) {
    super(`Worker pool '${pool}' is saturated (${max_queue_depth} queued tasks); submission rejected`);
    this.name = "PoolSaturatedError";
  }
}

/** Postgres/`pg` error codes that indicate a transient condition worth retrying. */
const TRANSIENT_PG_CODES = new Set([
  "08000", // connection_exception
  "08003", // connection_does_not_exist
  "08006", // connection_failure
  "08001", // sqlclient_unable_to_establish_sqlconnection
  "08004", // sqlserver_rejected_establishment_of_sqlconnection
  "57P01", // admin_shutdown
  "57P02", // crash_shutdown
  "57P03", // cannot_connect_now
  "53300", // too_many_connections
  "40001", // serialization_failure
  "40P01", // deadlock_detected
]);

/** Node/libuv syscall error codes that indicate a transient network condition. */
const TRANSIENT_SYS_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ECONNABORTED",
  "ETIMEDOUT",
  "EPIPE",
  "EAI_AGAIN",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENETDOWN",
  "EADDRINUSE",
  "EMFILE",
  "ENFILE",
]);

/**
 * Default transient-error classifier.
 *
 * Conservative by design: an error is retried only when there is positive,
 * deterministic evidence that retrying could help (a timeout, a connection
 * or pool failure, a serialization conflict, a 5xx from an outbound call,
 * or an explicit `retryable: true` marker). Everything else — validation
 * failures, "not found", business-rule rejections, programming errors — is
 * treated as permanent and surfaced immediately, so a genuine bug is never
 * masked by three silent retries.
 */
export function isTransientError(err: unknown): boolean {
  if (err instanceof AgentTimeoutError) return true;
  if (err instanceof PoolSaturatedError) return true;
  if (err instanceof AgentCircuitOpenError) return false;

  if (typeof err !== "object" || err === null) return false;
  const e = err as { retryable?: unknown; code?: unknown; status?: unknown; statusCode?: unknown; message?: unknown };

  if (e.retryable === true) return true;
  if (e.retryable === false) return false;

  if (typeof e.code === "string") {
    if (TRANSIENT_SYS_CODES.has(e.code)) return true;
    if (TRANSIENT_PG_CODES.has(e.code)) return true;
  }

  const status = typeof e.status === "number" ? e.status : typeof e.statusCode === "number" ? e.statusCode : null;
  if (status !== null && status >= 500 && status <= 599) return true;

  // Last resort: a small, explicit allow-list of message shapes emitted by
  // dependencies that do not set a machine-readable code.
  const message = typeof e.message === "string" ? e.message.toLowerCase() : "";
  return (
    message.includes("timeout") ||
    message.includes("temporarily unavailable") ||
    message.includes("connection terminated") ||
    message.includes("socket hang up")
  );
}

/** Exponential backoff with a hard ceiling. Pure — trivially testable. */
export function computeBackoffMs(attempt: number, baseMs: number, maxMs: number): number {
  if (baseMs <= 0) return 0;
  const raw = baseMs * Math.pow(2, Math.max(0, attempt));
  return Math.min(maxMs, raw);
}
