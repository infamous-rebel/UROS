/**
 * In-process runtime state for every agent known to the runner.
 *
 * This is the single source of truth behind `/health`'s per-agent section
 * and the `uros_agent_*` metrics. It is deliberately process-local and
 * non-persistent — like `utils/metrics.ts` and the in-memory rate limiter,
 * it describes *this instance's* view of an agent's resilience, and
 * Prometheus/UI aggregation across instances is the intended way to get a
 * fleet-wide picture. Durable state (batch progress, audit trail) lives in
 * Postgres; health telemetry does not need to.
 *
 * Bounded: one entry per registered agent name. Agents are registered at
 * module load from a fixed list (see ./registry.ts), so this map cannot
 * grow without bound the way a per-request-keyed cache could.
 */
import { CircuitBreaker } from "./circuit_breaker";
import { metrics, circuitStateToGaugeValue } from "../../utils/metrics";
import { logger } from "../../utils/logger";
import { logAudit } from "../../utils/audit_helper";
import { env } from "../../config/env.schema";
import { AgentClass, CircuitState } from "./types";

export interface AgentRuntimeState {
  agent_name: string;
  agent_class: AgentClass;
  registered_at: string;
  invocations: number;
  successes: number;
  failures: number;
  retries: number;
  timeouts: number;
  in_flight: number;
  last_success_at: string | null;
  last_failure_at: string | null;
  last_error: string | null;
  last_duration_ms: number | null;
  last_outcome: "success" | "failure" | "timeout" | "circuit_open" | null;
  circuit: CircuitBreaker;
}

/** What `/health` exposes per agent. No internals, no stack traces. */
export interface AgentHealthEntry {
  agent_name: string;
  agent_class: AgentClass;
  circuit_state: CircuitState;
  consecutive_failures: number;
  circuit_retry_after_ms: number;
  invocations: number;
  successes: number;
  failures: number;
  retries: number;
  timeouts: number;
  in_flight: number;
  last_success_at: string | null;
  last_failure_at: string | null;
  last_error: string | null;
  last_duration_ms: number | null;
  /** Aggregate health of this agent, derived deterministically from the above. */
  status: "healthy" | "degraded" | "unavailable" | "idle";
}

const states = new Map<string, AgentRuntimeState>();

function publishCircuitGauge(agentName: string, state: CircuitState): void {
  metrics.agentCircuitState.set({ agent: agentName }, circuitStateToGaugeValue(state));
}

/**
 * Returns the state record for `agentName`, creating it (and its circuit
 * breaker) on first use. Breaker transitions are logged, audited and
 * published as metrics from here, so registering an agent is enough to
 * get full circuit observability — no per-agent code.
 */
export function getOrCreateAgentState(agentName: string, agentClass: AgentClass): AgentRuntimeState {
  const existing = states.get(agentName);
  if (existing) return existing;

  const created: AgentRuntimeState = {
    agent_name: agentName,
    agent_class: agentClass,
    registered_at: new Date().toISOString(),
    invocations: 0,
    successes: 0,
    failures: 0,
    retries: 0,
    timeouts: 0,
    in_flight: 0,
    last_success_at: null,
    last_failure_at: null,
    last_error: null,
    last_duration_ms: null,
    last_outcome: null,
    circuit: undefined as unknown as CircuitBreaker,
  };

  created.circuit = new CircuitBreaker({
    name: agentName,
    failureThreshold: env.AGENT_CIRCUIT_FAILURE_THRESHOLD,
    resetMs: env.AGENT_CIRCUIT_RESET_MS,
    onStateChange: (from, to, info) => {
      publishCircuitGauge(agentName, to);
      logger.warn("AGENT_CIRCUIT_STATE_CHANGED", {
        agent_name: agentName,
        agent_class: agentClass,
        from,
        to,
        reason: info.reason,
        consecutive_failures: info.consecutive_failures,
      });
      if (to === "OPEN") metrics.agentCircuitOpenTotal.inc({ agent: agentName, agent_class: agentClass });
      // Circuit state changes are operationally significant decisions about
      // whether the platform will accept work — audited, not just logged.
      void logAudit({
        entity_type: "AGENT",
        entity_id: agentName,
        agent_or_user: "AgentRunner",
        action: `AGENT_CIRCUIT_${to}`,
        output_value: { from, to, reason: info.reason, consecutive_failures: info.consecutive_failures },
        reason_code: `CIRCUIT_${to}`,
        reason_comment: `Circuit breaker for agent '${agentName}' moved ${from} -> ${to} (${info.reason}).`,
      });
    },
  });

  publishCircuitGauge(agentName, created.circuit.state);
  states.set(agentName, created);
  return created;
}

export function getAgentState(agentName: string): AgentRuntimeState | undefined {
  return states.get(agentName);
}

export function listAgentStates(): AgentRuntimeState[] {
  return [...states.values()];
}

/** Test/ops hook: drops all runtime state and closes every breaker. */
export function resetAgentStates(): void {
  states.clear();
}

/**
 * Deterministic per-agent status for `/health`:
 *  - idle          never invoked since process start
 *  - unavailable   circuit OPEN (calls are being rejected right now)
 *  - degraded      circuit HALF_OPEN, or failures recorded but circuit closed
 *  - healthy       circuit CLOSED and the last invocation succeeded
 */
export function deriveAgentStatus(state: AgentRuntimeState): AgentHealthEntry["status"] {
  const circuitState = state.circuit.state;
  if (circuitState === "OPEN") return "unavailable";
  if (circuitState === "HALF_OPEN") return "degraded";
  if (state.invocations === 0) return "idle";
  if (state.failures > 0 && state.last_outcome !== "success") return "degraded";
  return "healthy";
}

export function toAgentHealthEntry(state: AgentRuntimeState): AgentHealthEntry {
  const snap = state.circuit.snapshot();
  return {
    agent_name: state.agent_name,
    agent_class: state.agent_class,
    circuit_state: snap.state,
    consecutive_failures: snap.consecutive_failures,
    circuit_retry_after_ms: snap.retry_after_ms,
    invocations: state.invocations,
    successes: state.successes,
    failures: state.failures,
    retries: state.retries,
    timeouts: state.timeouts,
    in_flight: state.in_flight,
    last_success_at: state.last_success_at,
    last_failure_at: state.last_failure_at,
    last_error: state.last_error,
    last_duration_ms: state.last_duration_ms,
    status: deriveAgentStatus(state),
  };
}

/** Per-agent health for every agent known to the runner, sorted by name for stable output. */
export function getAgentHealthSnapshot(): AgentHealthEntry[] {
  return listAgentStates().map(toAgentHealthEntry).sort((a, b) => a.agent_name.localeCompare(b.agent_name));
}
