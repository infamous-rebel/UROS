/**
 * Agent registry: the stable interface between callers and agents.
 *
 * An agent is registered once by name; callers invoke it by that name and
 * never import the agent module directly. That indirection is what makes
 * the hardening universal:
 *  - resilience (timeout / retry / circuit / audit / metrics) is applied by
 *    `runAgent`, not by each agent, so a *new* agent inherits it for free
 *    by registering — zero additional code;
 *  - the underlying stack is swappable. `AgentRegistration.handler` is just
 *    `(input, ctx) => Promise<output>`, so a future multi-agent framework
 *    can be plugged in behind the same names without touching a caller.
 *
 * Re-registering a name replaces the handler but preserves the existing
 * runtime state (circuit history, counters) — a hot swap must not silently
 * clear a tripped breaker.
 */
import { AgentClass, AgentRegistration } from "./types";
import { getOrCreateAgentState } from "./agent_state";

const registry = new Map<string, AgentRegistration<any, any>>();

/** Registers (or replaces) an agent and materialises its runtime state + circuit breaker. */
export function registerAgent<TInput = unknown, TOutput = unknown>(
  registration: AgentRegistration<TInput, TOutput>
): void {
  registry.set(registration.name, registration as AgentRegistration<any, any>);
  getOrCreateAgentState(registration.name, registration.agent_class);
}

export function registerAgents(registrations: Array<AgentRegistration<any, any>>): void {
  for (const r of registrations) registerAgent(r);
}

export function getAgent<TInput = unknown, TOutput = unknown>(
  name: string
): AgentRegistration<TInput, TOutput> | undefined {
  return registry.get(name) as AgentRegistration<TInput, TOutput> | undefined;
}

export function hasAgent(name: string): boolean {
  return registry.has(name);
}

export function listAgentNames(): string[] {
  return [...registry.keys()].sort();
}

export function listRegistrations(): Array<{ name: string; agent_class: AgentClass }> {
  return [...registry.values()]
    .map((r) => ({ name: r.name, agent_class: r.agent_class }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Test hook: empty the registry (runtime state is reset separately via `resetAgentStates`). */
export function resetRegistry(): void {
  registry.clear();
}
