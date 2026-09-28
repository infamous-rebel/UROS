/**
 * Agent-Level Hardening — public surface.
 *
 * Import from here, not from the individual modules, so the internal
 * decomposition can change without touching callers:
 *
 *   runAgent(name, input, ctx)        execute a registered agent with timeout,
 *                                     retry, circuit breaking, logging, audit
 *                                     and metrics applied around it
 *   enqueueAgent(name, input, ctx)    same, dispatched through the agent
 *                                     class's worker pool (background work)
 *   registerAgent({...})              add a new agent; resilience is inherited
 *   runBatchIsolated({...})           per-item error isolation for a batch loop
 *   runResumableBatch({...})          per-item isolation + durable progress,
 *                                     resumes after a crash instead of restarting
 *   supervise({...})                  restart a long-running loop that throws
 *   bootstrapAgentRuntime()           process start-up: register agents,
 *                                     reclaim orphaned batches
 *   buildAgentHealthReport()          per-agent status for /health and the UI
 *
 * Design constraints honoured here: hardening lives in this module (never
 * inside an agent), the happy path adds only a map lookup + a cleared timer,
 * resilience activates on failure, and nothing is coupled to a particular
 * multi-agent framework — a handler is just `(input, ctx) => Promise<output>`.
 */
export * from "./types";
export * from "./circuit_breaker";
export * from "./registry";
export * from "./agent_state";
export * from "./agent_health";
export * from "./worker_pool";
export * from "./pools";
export * from "./runner";
export * from "./batch";
export * from "./supervisor";
export { AGENT_NAMES, AGENT_REGISTRATIONS, registerAllAgents, resetAgentRegistrationForTests } from "./agents";
export type { AgentName } from "./agents";
