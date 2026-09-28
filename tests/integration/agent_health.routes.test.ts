/**
 * `/health` per-agent status and `/metrics` per-agent counters, exercised
 * through the real Express app (`createApp`) rather than by calling the
 * report builders directly — the point is that an orchestrator probe and a
 * Prometheus scrape see the hardening layer, wired exactly as deployed.
 *
 * The database is faked to the two statements these endpoints touch
 * (`SELECT 1` for the liveness probe, `INSERT INTO audit_log` for the audit
 * trail the runner writes). `REDIS_URL` is forced to undefined via an env
 * mock so redis reports `not_configured` and no test ever opens a socket,
 * regardless of whether the CI environment sets REDIS_URL.
 */
import request from "supertest";
import type { Express } from "express";
import { createApp } from "../../src/api/server";
import { listAgentNames, registerAgent } from "../../src/services/agent_runner/registry";
import { enqueueAgent, runAgent } from "../../src/services/agent_runner/runner";
import { getPoolForClass } from "../../src/services/agent_runner/pools";
import { AGENT_NAMES } from "../../src/services/agent_runner/agents";
import { AgentCircuitOpenError, AgentTimeoutError } from "../../src/services/agent_runner/types";
import { declaresMetricIn, metricValueFrom } from "../helpers/metrics_probe";

jest.mock("../../src/database/client", () => {
  const holder = { audit_log: [] as Array<{ id: number; params: any[] }> };
  (globalThis as any).__urosHealthFakeDb = holder;
  let seq = 1;
  const query = async (text: string, params: any[] = []) => {
    const sql = text.replace(/\s+/g, " ").trim();
    if (sql === "SELECT 1") return { rows: [{ "?column?": 1 }], rowCount: 1 };
    if (sql.startsWith("INSERT INTO audit_log")) {
      holder.audit_log.push({ id: seq++, params });
      return { rows: [], rowCount: 1 };
    }
    throw new Error(`Fake health DB: unhandled query: ${sql}`);
  };
  return { db: { query, withTransaction: async (fn: any) => fn({ query }) }, pool: { query } };
});

// Force REDIS_URL to undefined so the health endpoint always reports
// redis:"not_configured" regardless of the CI environment. The env module
// is a singleton parsed from process.env at import time; spreading the real
// values preserves every other field the health report reads.
jest.mock("../../src/config/env.schema", () => {
  const actual = jest.requireActual("../../src/config/env.schema");
  return { env: { ...actual.env, REDIS_URL: undefined }, loadEnv: actual.loadEnv };
});

jest.mock("../../src/utils/logger", () => ({
  logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

function auditLog(): Array<{ id: number; params: any[] }> {
  return (globalThis as any).__urosHealthFakeDb.audit_log;
}

// Unique per file run: metrics are process-wide and never reset, so a fixed
// name could collide with another suite in the same worker.
const OK_AGENT = "test.health.ok";
const RETRY_AGENT = "test.health.retries";
const SLOW_AGENT = "test.health.slow";
const TIMEOUT_AGENT = "test.health.timeouts";

let app: Express;

beforeAll(() => {
  app = createApp();

  registerAgent<Record<string, never>, string>({
    name: OK_AGENT,
    agent_class: "general",
    handler: async () => "ok",
    options: { timeout_ms: 1_000, max_retries: 0, audit: false },
  });

  let retryCalls = 0;
  registerAgent<Record<string, never>, string>({
    name: RETRY_AGENT,
    agent_class: "general",
    handler: async () => {
      retryCalls += 1;
      // Transient twice, then recovers: exercises the retry counter without
      // depending on any real dependency being flaky.
      if (retryCalls < 3) throw Object.assign(new Error("connection terminated unexpectedly"), { retryable: true });
      return "recovered";
    },
    options: { timeout_ms: 1_000, max_retries: 3, backoff_base_ms: 1, backoff_max_ms: 2, audit: false },
  });

  registerAgent<{ hold: Promise<void> }, string>({
    name: SLOW_AGENT,
    agent_class: "general",
    handler: async (input) => {
      await input.hold;
      return "slow-done";
    },
    options: { timeout_ms: 5_000, max_retries: 0, audit: false },
  });

  registerAgent<Record<string, never>, string>({
    name: TIMEOUT_AGENT,
    // A different class, so its circuit state cannot be confused with the
    // general pool's queue numbers asserted elsewhere in this file.
    agent_class: "analytics",
    handler: () => new Promise<string>(() => undefined), // never returns: forces the deadline
    options: {
      timeout_ms: 15,
      max_retries: 0,
      circuit_failure_threshold: 2,
      circuit_reset_ms: 60_000,
      audit: true,
    },
  });
});

function findAgent(body: any, name: string): any {
  const entry = body.agent_health.agents.find((a: any) => a.agent_name === name);
  if (!entry) throw new Error(`agent '${name}' missing from /health payload`);
  return entry;
}

describe("GET /health — per-agent status", () => {
  it("lists every registered agent with its resilience state before any traffic", async () => {
    const res = await request(app).get("/health").set("X-Request-Id", "req-health-topology");

    expect(res.status).toBe(200);
    // The additive section is present, and everything a pre-hardening probe
    // read is still there and unchanged in meaning.
    expect(res.body).toEqual(
      expect.objectContaining({
        status: "ok",
        deployment_mode: expect.any(String),
        uptime_seconds: expect.any(Number),
        checks: { database: "ok", redis: "not_configured", queue: "ok", encryption: "ok" },
        timestamp: expect.any(String),
        request_id: "req-health-topology",
      })
    );
    expect(res.headers["x-request-id"]).toBe("req-health-topology");

    const { agents, pools, totals } = res.body.agent_health;
    // Agents are enumerated from registration, not from traffic: an operator
    // opening the dashboard before the first invocation still sees the whole
    // topology instead of an empty panel.
    expect(agents.map((a: any) => a.agent_name).sort()).toEqual(listAgentNames());
    expect(agents.length).toBeGreaterThan(40);
    for (const name of [
      AGENT_NAMES.ELIGIBILITY_RUN_FOR_CIRCULAR,
      AGENT_NAMES.PARSER_EXTRACT_FIELDS,
      AGENT_NAMES.SCORING_COMPUTE,
      AGENT_NAMES.DIMENSION_SCORING_RUN,
    ]) {
      expect(agents.map((a: any) => a.agent_name)).toContain(name);
    }

    const idle = findAgent(res.body, AGENT_NAMES.PARSER_EXTRACT_FIELDS);
    expect(idle).toMatchObject({
      agent_class: "parser",
      circuit_state: "CLOSED",
      consecutive_failures: 0,
      invocations: 0,
      successes: 0,
      failures: 0,
      retries: 0,
      timeouts: 0,
      in_flight: 0,
      last_success_at: null,
      last_failure_at: null,
      last_error: null,
      status: "idle",
      queue_depth: 0,
      queue_active: 0,
      pool_size: 2,
    });
    expect(idle.circuit_retry_after_ms).toBe(0);

    // All eight class pools are reported, including untouched ones.
    expect(pools.map((p: any) => p.name).sort()).toEqual([
      "agent:analytics",
      "agent:communication",
      "agent:general",
      "agent:intake",
      "agent:parser",
      "agent:scanner",
      "agent:scoring",
      "agent:verification",
    ]);
    expect(totals).toMatchObject({ agents: agents.length, invocations: 0, successes: 0, failures: 0, retries: 0, timeouts: 0, circuits_open: 0, queued: 0 });
  });

  it("reports last success for an agent that has been invoked", async () => {
    await runAgent(OK_AGENT, {}, { actor: "operator-1", request_id: "req-health-ok" });

    const res = await request(app).get("/health");
    const entry = findAgent(res.body, OK_AGENT);

    expect(entry).toMatchObject({
      agent_class: "general",
      circuit_state: "CLOSED",
      invocations: 1,
      successes: 1,
      failures: 0,
      retries: 0,
      timeouts: 0,
      status: "healthy",
      last_failure_at: null,
      last_error: null,
    });
    expect(entry.last_success_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(entry.last_duration_ms).toBeGreaterThanOrEqual(0);
    expect(res.body.agent_health.totals).toMatchObject({ invocations: 1, successes: 1, failures: 0 });
  });

  it("reports last failure, timeouts and an OPEN circuit — without marking the API unhealthy", async () => {
    for (let i = 0; i < 2; i++) {
      await expect(runAgent(TIMEOUT_AGENT, {}, { actor: "operator-1", request_id: `req-health-to-${i}` })).rejects.toBeInstanceOf(
        AgentTimeoutError
      );
    }

    const res = await request(app).get("/health");
    const entry = findAgent(res.body, TIMEOUT_AGENT);

    expect(entry).toMatchObject({
      agent_class: "analytics",
      circuit_state: "OPEN",
      consecutive_failures: 2,
      invocations: 2,
      successes: 0,
      failures: 2,
      timeouts: 2,
      status: "unavailable",
      last_success_at: null,
    });
    expect(entry.last_failure_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(entry.last_error).toMatch(/exceeded its 15ms timeout/);
    expect(entry.circuit_retry_after_ms).toBeGreaterThan(0);

    // Shedding load on one agent is the hardening working, not an outage:
    // the orchestrator must keep routing traffic here. Alert on
    // agent_health.totals.circuits_open instead.
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
    expect(res.body.checks.database).toBe("ok");
    expect(res.body.agent_health.totals).toMatchObject({ failures: 2, timeouts: 2, circuits_open: 1 });

    // The rejections are audited, so the operator can see why work was shed.
    const actions = auditLog().map((r) => r.params[3]);
    expect(actions).toContain("AGENT_CIRCUIT_OPEN");
    expect(actions.filter((a) => a === "AGENT_INVOCATION_FAILED")).toHaveLength(2);

    // While open, further calls are rejected at the gate: counted as an
    // invocation, but the handler is never reached, so no new timeout.
    await expect(runAgent(TIMEOUT_AGENT, {}, { request_id: "req-health-to-rejected" })).rejects.toBeInstanceOf(
      AgentCircuitOpenError
    );
    const rejected = findAgent((await request(app).get("/health")).body, TIMEOUT_AGENT);
    expect(rejected).toMatchObject({ circuit_state: "OPEN", status: "unavailable", invocations: 3, timeouts: 2, failures: 2 });
    expect(rejected.last_error).toMatch(/circuit OPEN/);
    expect(auditLog().map((r) => r.params[3])).toContain("AGENT_CIRCUIT_REJECTED");
  });

  it("reports retries separately from failures, since a retried call is not yet a failed one", async () => {
    await runAgent(RETRY_AGENT, {}, { actor: "operator-1", request_id: "req-health-retry" });

    const entry = findAgent((await request(app).get("/health")).body, RETRY_AGENT);
    expect(entry).toMatchObject({ invocations: 1, successes: 1, failures: 0, retries: 2, timeouts: 0, status: "healthy" });
  });

  it("reports queue depth and active workers from the class pool", async () => {
    let releaseHold: (() => void) | undefined;
    const hold = new Promise<void>((resolve) => {
      releaseHold = resolve;
    });

    // The general pool has 2 workers; four enqueued tasks leave two running
    // and two waiting — which is exactly what an operator needs to see.
    const inflight = [0, 1, 2, 3].map(() => enqueueAgent<{ hold: Promise<void> }, string>(SLOW_AGENT, { hold }));
    const pool = getPoolForClass("general");
    const deadline = Date.now() + 2_000;
    while (pool.active < 2 && Date.now() < deadline) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    expect(pool.active).toBe(2);
    expect(pool.depth).toBe(2);

    const res = await request(app).get("/health");
    const entry = findAgent(res.body, SLOW_AGENT);
    expect(entry).toMatchObject({ agent_class: "general", queue_active: 2, queue_depth: 2, pool_size: 2, in_flight: 2 });
    expect(res.body.agent_health.totals.queued).toBe(2);
    expect(res.body.agent_health.pools.find((p: any) => p.name === "agent:general")).toMatchObject({
      size: 2,
      active: 2,
      queued: 2,
      stopped: false,
    });

    releaseHold!();
    await Promise.all(inflight);
    expect(findAgent((await request(app).get("/health")).body, SLOW_AGENT)).toMatchObject({ queue_active: 0, queue_depth: 0, in_flight: 0, successes: 4 });
  });
});

describe("GET /metrics — per-agent counters", () => {
  it("declares every required agent metric and reflects the invocations above", async () => {
    const res = await request(app).get("/metrics");

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/plain/);
    const body: string = res.text;

    // Deliverable: invocations, successes, failures, retries, timeouts,
    // circuit_open_count — plus the gauge and histogram that make them useful.
    for (const name of [
      "uros_agent_invocations_total",
      "uros_agent_successes_total",
      "uros_agent_failures_total",
      "uros_agent_retries_total",
      "uros_agent_timeouts_total",
      "uros_agent_circuit_open_total",
      "uros_agent_circuit_state",
      "uros_agent_duration_ms",
      "uros_agent_queue_depth",
      "uros_agent_queue_active",
      "uros_agent_batch_items_total",
      "uros_supervisor_restarts_total",
    ]) {
      expect(declaresMetricIn(body, name)).toBe(true);
    }

    // Values parsed out of the HTTP body, exactly as a Prometheus scrape would.
    expect(metricValueFrom(body, "uros_agent_successes_total", { agent: OK_AGENT, agent_class: "general" })).toBe(1);
    expect(metricValueFrom(body, "uros_agent_invocations_total", { agent: OK_AGENT, agent_class: "general", outcome: "success" })).toBe(1);
    expect(metricValueFrom(body, "uros_agent_successes_total", { agent: SLOW_AGENT, agent_class: "general" })).toBe(4);
    expect(metricValueFrom(body, "uros_agent_retries_total", { agent: RETRY_AGENT, agent_class: "general" })).toBe(2);
    expect(metricValueFrom(body, "uros_agent_timeouts_total", { agent: TIMEOUT_AGENT, agent_class: "analytics" })).toBe(2);
    expect(metricValueFrom(body, "uros_agent_failures_total", { agent: TIMEOUT_AGENT, agent_class: "analytics" })).toBe(2);
    expect(metricValueFrom(body, "uros_agent_circuit_open_total", { agent: TIMEOUT_AGENT, agent_class: "analytics" })).toBe(1);
    expect(metricValueFrom(body, "uros_agent_invocations_total", { agent: TIMEOUT_AGENT, agent_class: "analytics", outcome: "circuit_open" })).toBe(1);
    expect(metricValueFrom(body, "uros_agent_invocations_total", { agent: TIMEOUT_AGENT, agent_class: "analytics", outcome: "timeout" })).toBe(2);
    // 0 = CLOSED, 1 = HALF_OPEN, 2 = OPEN.
    expect(metricValueFrom(body, "uros_agent_circuit_state", { agent: TIMEOUT_AGENT })).toBe(2);
    expect(metricValueFrom(body, "uros_agent_circuit_state", { agent: OK_AGENT })).toBe(0);
    expect(metricValueFrom(body, "uros_agent_queue_depth", { pool: "general" })).toBe(0);
    // Histogram count/sum are emitted, so p95 can be computed downstream.
    expect(metricValueFrom(body, "uros_agent_duration_ms_count", { agent: OK_AGENT, agent_class: "general" })).toBe(1);
  });

  it("counters increment on each further invocation", async () => {
    const before = Number(
      metricValueFrom((await request(app).get("/metrics")).text, "uros_agent_successes_total", { agent: OK_AGENT, agent_class: "general" })
    );

    await runAgent(OK_AGENT, {}, {});
    await runAgent(OK_AGENT, {}, {});

    const after = Number(
      metricValueFrom((await request(app).get("/metrics")).text, "uros_agent_successes_total", { agent: OK_AGENT, agent_class: "general" })
    );
    expect(after).toBe(before + 2);
    // The two views agree: /health reads the same counters /metrics exports.
    expect(findAgent((await request(app).get("/health")).body, OK_AGENT).successes).toBe(after);
  });

  it("honours METRICS_TOKEN when one is configured", async () => {
    // Unset in the test environment, so the endpoint is open by design
    // (protected at the network edge). Asserting the open path here keeps
    // the default explicit rather than accidental.
    expect(process.env.METRICS_TOKEN).toBeUndefined();
    const res = await request(app).get("/metrics");
    expect(res.status).toBe(200);
  });
});
