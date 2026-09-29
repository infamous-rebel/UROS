/**
 * Per-provider, per-org circuit breaker.
 * States: CLOSED (normal) -> OPEN (tripped) -> HALF_OPEN (probe) -> CLOSED or OPEN.
 *
 * In-memory per API process (not persisted), matching the agent_runner
 * circuit breaker pattern. Prevents a broken provider from consuming
 * retry budget and fallback chain slots.
 */

import type { CircuitBreakerConfig } from "./types";
import { logger } from "../../../utils/logger";

export type CircuitState = "CLOSED" | "OPEN" | "HALF_OPEN";

interface CircuitEntry {
  state: CircuitState;
  failure_count: number;
  last_failure_at: number;
  last_state_change: number;
}

/** In-memory circuit breaker store, keyed by `${orgId}:${provider}`. */
const circuits = new Map<string, CircuitEntry>();

const DEFAULT_CB_CONFIG: CircuitBreakerConfig = {
  failure_threshold: 5,
  reset_timeout_ms: 30_000,
};

/** Per-org, per-provider configs (set via org integration settings). */
const configs = new Map<string, CircuitBreakerConfig>();

function circuitKey(orgId: string, provider: string): string {
  return `${orgId}:${provider}`;
}

function getOrCreateEntry(key: string): CircuitEntry {
  let entry = circuits.get(key);
  if (!entry) {
    entry = {
      state: "CLOSED",
      failure_count: 0,
      last_failure_at: 0,
      last_state_change: Date.now(),
    };
    circuits.set(key, entry);
  }
  return entry;
}

/** Set circuit breaker config for an org+provider. */
export function setConfig(orgId: string, provider: string, config: CircuitBreakerConfig): void {
  configs.set(circuitKey(orgId, provider), config);
}

function getConfig(orgId: string, provider: string): CircuitBreakerConfig {
  return configs.get(circuitKey(orgId, provider)) ?? DEFAULT_CB_CONFIG;
}

/**
 * Get the current circuit state for an org+provider.
 * Automatically transitions OPEN -> HALF_OPEN if reset_timeout has elapsed.
 */
export function getState(orgId: string, provider: string): CircuitState {
  const key = circuitKey(orgId, provider);
  const entry = getOrCreateEntry(key);
  const config = getConfig(orgId, provider);

  if (entry.state === "OPEN") {
    const elapsed = Date.now() - entry.last_state_change;
    if (elapsed >= config.reset_timeout_ms) {
      entry.state = "HALF_OPEN";
      entry.last_state_change = Date.now();
      logger.info("CIRCUIT_BREAKER_HALF_OPEN", { org_id: orgId, provider });
    }
  }

  return entry.state;
}

/**
 * Check if the circuit allows a request through.
 * CLOSED: yes. HALF_OPEN: yes (single probe). OPEN: no.
 */
export function allowRequest(orgId: string, provider: string): boolean {
  const state = getState(orgId, provider);
  return state !== "OPEN";
}

/** Record a successful call — resets the circuit to CLOSED. */
export function recordSuccess(orgId: string, provider: string): void {
  const key = circuitKey(orgId, provider);
  const entry = getOrCreateEntry(key);
  const prevState = entry.state;

  entry.state = "CLOSED";
  entry.failure_count = 0;
  entry.last_state_change = Date.now();

  if (prevState !== "CLOSED") {
    logger.info("CIRCUIT_BREAKER_CLOSED", { org_id: orgId, provider, previous_state: prevState });
  }
}

/** Record a failed call — may trip the circuit to OPEN. */
export function recordFailure(orgId: string, provider: string): void {
  const key = circuitKey(orgId, provider);
  const entry = getOrCreateEntry(key);
  const config = getConfig(orgId, provider);

  entry.failure_count += 1;
  entry.last_failure_at = Date.now();

  if (entry.state === "HALF_OPEN") {
    // Probe failed — re-open
    entry.state = "OPEN";
    entry.last_state_change = Date.now();
    logger.warn("CIRCUIT_BREAKER_REOPENED", { org_id: orgId, provider });
  } else if (entry.state === "CLOSED" && entry.failure_count >= config.failure_threshold) {
    entry.state = "OPEN";
    entry.last_state_change = Date.now();
    logger.warn("CIRCUIT_BREAKER_OPENED", {
      org_id: orgId,
      provider,
      failure_count: entry.failure_count,
      threshold: config.failure_threshold,
    });
  }
}

/** Reset all circuits (test-only). */
export function resetAllCircuits(): void {
  circuits.clear();
  configs.clear();
}

/** Get a snapshot of all circuit states (for admin dashboard). */
export function getAllCircuitStates(): Array<{
  org_id: string;
  provider: string;
  state: CircuitState;
  failure_count: number;
}> {
  return Array.from(circuits.entries()).map(([key, entry]) => {
    const [orgId, ...providerParts] = key.split(":");
    return {
      org_id: orgId,
      provider: providerParts.join(":"),
      state: entry.state,
      failure_count: entry.failure_count,
    };
  });
}
