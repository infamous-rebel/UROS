import Redis from "ioredis";
import { pool } from "../database/client";
import { env } from "../config/env.schema";
import { encryptSecret, decryptSecret } from "./encryption";
import { metrics } from "./metrics";
import { logger } from "./logger";
import { buildAgentHealthReport, AgentHealthReport } from "../services/agent_runner/agent_health";

export type ComponentStatus = "ok" | "down" | "not_configured";

export interface HealthReport {
  status: "ok" | "degraded" | "down";
  deployment_mode: string;
  uptime_seconds: number;
  checks: {
    database: ComponentStatus;
    redis: ComponentStatus;
    queue: ComponentStatus;
    encryption: ComponentStatus;
  };
  /**
   * Per-agent resilience status: circuit state, last success/failure, retry
   * and timeout counters, and worker-pool queue depth. Added by the
   * Agent-Level Hardening round; purely additive, so existing probes that
   * read only `status` and `checks` are unaffected.
   *
   * Deliberately NOT folded into the top-level `status`: an open circuit on
   * one agent means that agent is shedding load, which is the hardening
   * working as designed — it does not mean the API is unhealthy. Alert on
   * `agent_health.totals.circuits_open` instead.
   */
  agent_health: AgentHealthReport;
  timestamp: string;
  request_id?: string;
}

async function checkDatabase(): Promise<ComponentStatus> {
  try {
    await pool.query("SELECT 1");
    return "ok";
  } catch (err) {
    logger.error("HEALTH_CHECK_DATABASE_FAILED", { error: err instanceof Error ? err.message : String(err) });
    return "down";
  }
}

// Lazily created, reused across health checks. A dedicated client rather
// than piggybacking on BullMQ's connection keeps this check independent
// of whether a worker in this process has ever touched the queue.
let redisHealthClient: Redis | null = null;

async function checkRedis(): Promise<ComponentStatus> {
  if (!env.REDIS_URL) return "not_configured";
  try {
    if (!redisHealthClient) {
      redisHealthClient = new Redis(env.REDIS_URL, {
        lazyConnect: true,
        connectTimeout: 2_000,
        maxRetriesPerRequest: 1,
        retryStrategy: () => null, // never auto-reconnect loop inside a health probe
      });
      redisHealthClient.on("error", (err) => {
        logger.warn("HEALTH_CHECK_REDIS_CLIENT_ERROR", { error: err.message });
      });
    }
    if (redisHealthClient.status === "wait" || redisHealthClient.status === "close" || redisHealthClient.status === "end") {
      await redisHealthClient.connect();
    }
    const pong = await redisHealthClient.ping();
    return pong === "PONG" ? "ok" : "down";
  } catch (err) {
    logger.error("HEALTH_CHECK_REDIS_FAILED", { error: err instanceof Error ? err.message : String(err) });
    return "down";
  }
}

/**
 * The evaluation queue runs on BullMQ/Redis when `REDIS_URL` is set, and
 * falls back to the Postgres-backed poll worker (`FOR UPDATE SKIP LOCKED`,
 * see `services/queue/consumer.ts`) otherwise. Queue health therefore
 * mirrors whichever backend is actually in effect, not both.
 */
async function checkQueue(redisStatus: ComponentStatus): Promise<ComponentStatus> {
  if (env.REDIS_URL) return redisStatus;
  return checkDatabase();
}

/** Encrypts and decrypts a throwaway probe value to confirm ENCRYPTION_KEY is valid and functioning. */
function checkEncryption(): ComponentStatus {
  try {
    const probe = "uros-health-check-probe";
    const payload = encryptSecret(probe);
    const roundTrip = decryptSecret(payload);
    return roundTrip === probe ? "ok" : "down";
  } catch (err) {
    logger.error("HEALTH_CHECK_ENCRYPTION_FAILED", { error: err instanceof Error ? err.message : String(err) });
    return "down";
  }
}

function statusToGaugeValue(status: ComponentStatus): number {
  if (status === "ok") return 1;
  if (status === "not_configured") return 0.5;
  return 0;
}

export async function buildHealthReport(requestId?: string): Promise<HealthReport> {
  const database = await checkDatabase();
  const redis = await checkRedis();
  const queue = await checkQueue(redis);
  const encryption = checkEncryption();

  metrics.healthCheckStatus.set({ component: "database" }, statusToGaugeValue(database));
  metrics.healthCheckStatus.set({ component: "redis" }, statusToGaugeValue(redis));
  metrics.healthCheckStatus.set({ component: "queue" }, statusToGaugeValue(queue));
  metrics.healthCheckStatus.set({ component: "encryption" }, statusToGaugeValue(encryption));

  // Database and encryption are load-bearing for every request UROS
  // serves (candidate data, audit trail, BYOK credentials) — either
  // being down means the system cannot make deterministic, auditable
  // decisions, so it is reported DOWN rather than merely DEGRADED.
  const criticalDown = database === "down" || encryption === "down";
  const anyDown = [database, redis, queue, encryption].includes("down");

  const status: HealthReport["status"] = criticalDown ? "down" : anyDown ? "degraded" : "ok";

  return {
    status,
    deployment_mode: env.DEPLOYMENT_MODE,
    uptime_seconds: Math.round(process.uptime()),
    checks: { database, redis, queue, encryption },
    agent_health: buildAgentHealthReport(),
    timestamp: new Date().toISOString(),
    request_id: requestId,
  };
}

/** HTTP status code to accompany a given overall health status (for load balancer / orchestrator probes). */
export function httpStatusForHealth(status: HealthReport["status"]): number {
  if (status === "ok") return 200;
  if (status === "degraded") return 200; // still serving traffic; alerting should watch `checks`, not just the HTTP code
  return 503;
}
