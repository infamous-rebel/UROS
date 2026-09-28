/**
 * One worker pool per agent class, sized from environment.
 *
 * Pools are created lazily on first use so importing this module has no
 * side effects (important for tests and for the API process, which may
 * never touch a given class). Sizing comes from `AGENT_POOL_<CLASS>_SIZE`
 * with safe defaults declared in `config/env.schema.ts`.
 */
import { env } from "../../config/env.schema";
import { AgentClass, AGENT_CLASSES } from "./types";
import { WorkerPool, WorkerPoolSnapshot } from "./worker_pool";

/** Env var name -> pool size, derived from the class list so a new class cannot be forgotten. */
function poolSizeForClass(agentClass: AgentClass): number {
  const key = `AGENT_POOL_${agentClass.toUpperCase()}_SIZE` as keyof typeof env;
  const value = env[key];
  return typeof value === "number" ? value : env.AGENT_POOL_GENERAL_SIZE;
}

const pools = new Map<AgentClass, WorkerPool>();

/** Returns (creating if necessary) the pool that governs `agentClass`. */
export function getPoolForClass(agentClass: AgentClass): WorkerPool {
  const existing = pools.get(agentClass);
  if (existing) return existing;
  const created = new WorkerPool({
    name: `agent:${agentClass}`,
    size: poolSizeForClass(agentClass),
    maxQueueDepth: env.AGENT_POOL_MAX_QUEUE_DEPTH,
    metricLabel: agentClass,
  });
  pools.set(agentClass, created);
  return created;
}

export function listPools(): WorkerPool[] {
  // Touch every class so the snapshot always reports the full, configured
  // topology — an operator reading /metrics should see all eight pools,
  // including the ones this process has not needed yet.
  for (const c of AGENT_CLASSES) getPoolForClass(c);
  return [...pools.values()];
}

export function poolSnapshots(): WorkerPoolSnapshot[] {
  return listPools()
    .map((p) => p.snapshot())
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Queue depth per agent class, for the `/health` per-agent section. */
export function queueDepthByClass(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const p of listPools()) {
    out[p.name.replace("agent:", "")] = p.depth;
  }
  return out;
}

export function poolSizeByClass(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const c of AGENT_CLASSES) out[c] = poolSizeForClass(c);
  return out;
}

/** Graceful-shutdown hook: stop accepting work, let in-flight tasks finish. */
export async function shutdownAllPools(): Promise<void> {
  await Promise.all([...pools.values()].map((p) => p.shutdown()));
}

/** Test hook: drop pooled workers so the next call re-creates them from current env. */
export function resetPools(): void {
  pools.clear();
}
