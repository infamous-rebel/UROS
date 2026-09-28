/**
 * Composition layer for the per-agent view exposed on `/health`.
 *
 * Merges two independent sources — per-agent runtime state (circuit,
 * counters, last success/failure) from `agent_state.ts`, and per-class
 * worker pool saturation from `pools.ts` — into one flat report an operator
 * or the dashboard can read in a single call.
 */
import { AgentHealthEntry, getAgentHealthSnapshot } from "./agent_state";
import { getPoolForClass, poolSnapshots } from "./pools";
import { WorkerPoolSnapshot } from "./worker_pool";

export interface AgentHealthView extends AgentHealthEntry {
  /** Tasks waiting for a worker in this agent's class pool. */
  queue_depth: number;
  /** Tasks currently executing in this agent's class pool. */
  queue_active: number;
  /** Configured worker count for this agent's class pool. */
  pool_size: number;
}

export interface AgentHealthTotals {
  agents: number;
  invocations: number;
  successes: number;
  failures: number;
  retries: number;
  timeouts: number;
  circuits_open: number;
  queued: number;
}

export interface AgentHealthReport {
  agents: AgentHealthView[];
  pools: WorkerPoolSnapshot[];
  totals: AgentHealthTotals;
}

/** Builds the full per-agent + per-pool health report. Pure read; never throws. */
export function buildAgentHealthReport(): AgentHealthReport {
  const agents: AgentHealthView[] = getAgentHealthSnapshot().map((entry) => {
    const pool = getPoolForClass(entry.agent_class);
    return {
      ...entry,
      queue_depth: pool.depth,
      queue_active: pool.active,
      pool_size: pool.size,
    };
  });

  const pools = poolSnapshots();

  const totals: AgentHealthTotals = {
    agents: agents.length,
    invocations: agents.reduce((sum, a) => sum + a.invocations, 0),
    successes: agents.reduce((sum, a) => sum + a.successes, 0),
    failures: agents.reduce((sum, a) => sum + a.failures, 0),
    retries: agents.reduce((sum, a) => sum + a.retries, 0),
    timeouts: agents.reduce((sum, a) => sum + a.timeouts, 0),
    circuits_open: agents.filter((a) => a.circuit_state === "OPEN").length,
    queued: pools.reduce((sum, p) => sum + p.queued, 0),
  };

  return { agents, pools, totals };
}
