/**
 * Unit tests for the generic agent runner: timeout, transient retry with
 * exponential backoff, per-agent circuit breaking, structured logging and
 * the audit trail.
 *
 * These tests exercise the runner with *synthetic* agents registered under
 * their own names. That is the point of the design under test: the runner
 * knows nothing about what an agent does, so any handler — today's UROS
 * agents or a future multi-agent stack — gets identical resilience.
 *
 * `logAudit` and `logger` are mocked: the real ones write to Postgres and
 * stdout respectively, and both are observable outputs we want to assert on
 * rather than side effects we want to perform.
 */
import { runAgent, enqueueAgent, runnerInternals, defaultRunnerOptions } from "../../../src/services/agent_runner/runner";
import { registerAgent, resetRegistry, listAgentNames, hasAgent } from "../../../src/services/agent_runner/registry";
import { resetAgentStates, getAgentState } from "../../../src/services/agent_runner/agent_state";
import { resetPools, getPoolForClass } from "../../../src/services/agent_runner/pools";
import { registerAllAgents } from "../../../src/services/agent_runner/agents";
import {
  AgentCircuitOpenError,
  AgentNotRegisteredError,
  AgentRegistration,
  AgentRunnerOverrides,
  AgentTimeoutError,
  computeBackoffMs,
  isTransientError,
} from "../../../src/services/agent_runner/types";
import { env } from "../../../src/config/env.schema";
import { logAudit } from "../../../src/utils/audit_helper";
import { logger } from "../../../src/utils/logger";
import { metricValue } from "../../helpers/metrics_probe";

jest.mock("../../../src/utils/audit_helper", () => ({
  logAudit: jest.fn(async () => undefined),
}));

jest.mock("../../../src/utils/logger", () => ({
  logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

// The runner lazily registers the built-in catalogue the first time it is
// asked for a name it does not know. Stubbed so these unit tests never pull
// in every agent module (and, transitively, a real Postgres pool).
jest.mock("../../../src/services/agent_runner/agents", () => ({
  registerAllAgents: jest.fn(),
}));

const auditMock = logAudit as jest.MockedFunction<typeof logAudit>;
const registerAllMock = registerAllAgents as jest.MockedFunction<typeof registerAllAgents>;

const realSleep = runnerInternals.sleep;
let sleepSpy: jest.Mock;

/** Fast, fully deterministic resilience settings. Tests override only what they care about. */
const FAST: AgentRunnerOverrides = {
  timeout_ms: 500,
  max_retries: 0,
  backoff_base_ms: 1,
  backoff_max_ms: 4,
  circuit_failure_threshold: 3,
  circuit_reset_ms: 60_000,
  audit: true,
};

let nameSeq = 0;
/** Unique name per test: the metrics registry is process-wide and never resets. */
function agentName(prefix: string): string {
  nameSeq += 1;
  return `test.${prefix}.${nameSeq}`;
}

function register<I, O>(
  name: string,
  handler: (input: I) => Promise<O>,
  options: AgentRunnerOverrides = {}
): AgentRegistration<I, O> {
  const registration: AgentRegistration<I, O> = {
    name,
    agent_class: "general",
    handler: async (input) => handler(input),
    options: { ...FAST, ...options },
  };
  registerAgent(registration);
  return registration;
}

function auditActions(): string[] {
  return auditMock.mock.calls.map((c) => c[0].action);
}

function auditRows(action: string) {
  return auditMock.mock.calls.map((c) => c[0]).filter((r) => r.action === action);
}

/** A promise that never settles — stands in for a hung dependency. */
function never<T>(): Promise<T> {
  return new Promise<T>(() => undefined);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

beforeEach(() => {
  resetRegistry();
  resetAgentStates();
  resetPools();
  sleepSpy = jest.fn(async (_ms: number) => undefined);
  runnerInternals.sleep = sleepSpy as unknown as (ms: number) => Promise<void>;
});

afterEach(() => {
  runnerInternals.sleep = realSleep;
});

describe("runAgent: happy path", () => {
  it("returns the handler's output untouched and calls it exactly once", async () => {
    const name = agentName("echo");
    const handler = jest.fn(async (input: { n: number }) => ({ doubled: input.n * 2 }));
    register(name, handler);

    const out = await runAgent<{ n: number }, { doubled: number }>(name, { n: 21 });

    expect(out).toEqual({ doubled: 42 });
    expect(handler).toHaveBeenCalledTimes(1);
    expect(getAgentState(name)).toMatchObject({ invocations: 1, successes: 1, failures: 0, retries: 0, timeouts: 0, in_flight: 0, last_outcome: "success" });
    expect(getAgentState(name)!.last_success_at).not.toBeNull();
    expect(getAgentState(name)!.last_duration_ms).toBeGreaterThanOrEqual(0);
  });

  it("adds no resilience overhead beyond the audit rows UROS already requires", async () => {
    const name = agentName("quiet");
    register(name, async () => "ok");

    await runAgent(name, {});

    expect(auditActions()).toEqual(["AGENT_INVOCATION_STARTED", "AGENT_INVOCATION_SUCCEEDED"]);
    expect(sleepSpy).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
    // Success is a debug-level event: a 50k-item batch must not emit 50k info lines.
    expect(logger.debug).toHaveBeenCalledWith("AGENT_INVOCATION_SUCCEEDED", expect.objectContaining({ agent_name: name }));
  });

  it("propagates the caller's request_id into both the log and the audit trail", async () => {
    const name = agentName("correlated");
    register(name, async () => "ok");

    await runAgent(name, {}, { request_id: "req-fixed-123", actor: "hr-user-9", entity_type: "CANDIDATE", entity_id: "UROS-1" });

    expect(logger.debug).toHaveBeenCalledWith(
      "AGENT_INVOCATION_STARTED",
      expect.objectContaining({ request_id: "req-fixed-123", agent_name: name, agent_class: "general" })
    );
    for (const row of auditMock.mock.calls.map((c) => c[0])) {
      expect(row.agent_or_user).toBe("hr-user-9");
      expect(row.entity_type).toBe("CANDIDATE");
      expect(row.entity_id).toBe("UROS-1");
      expect(row.input_value).toMatchObject({ request_id: "req-fixed-123" });
    }
  });

  it("generates a request_id when the caller supplies none", async () => {
    const name = agentName("generated-rid");
    register(name, async () => "ok");

    await runAgent(name, {});

    const started = auditRows("AGENT_INVOCATION_STARTED")[0];
    const startedInput = started.input_value as { request_id?: string };
    expect(startedInput.request_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  });

  it("can be switched off for audit via the AGENT_AUDIT_ENABLED-derived option", async () => {
    const name = agentName("no-audit");
    register(name, async () => "ok", { audit: false });

    await runAgent(name, {});

    expect(auditMock).not.toHaveBeenCalled();
    expect(getAgentState(name)!.successes).toBe(1);
  });

  it("increments the per-agent success and invocation counters", async () => {
    const name = agentName("metrics-ok");
    register(name, async () => "ok");

    await runAgent(name, {});
    await runAgent(name, {});

    expect(metricValue("uros_agent_successes_total", { agent: name, agent_class: "general" })).toBe(2);
    expect(metricValue("uros_agent_invocations_total", { agent: name, agent_class: "general", outcome: "success" })).toBe(2);
    expect(metricValue("uros_agent_duration_ms_count", { agent: name, agent_class: "general" })).toBe(2);
  });
});

describe("runAgent: unknown agents", () => {
  it("rejects with AgentNotRegisteredError after trying the built-in catalogue", async () => {
    await expect(runAgent("test.does.not.exist", {})).rejects.toBeInstanceOf(AgentNotRegisteredError);
    expect(registerAllMock).toHaveBeenCalled();
    expect(hasAgent("test.does.not.exist")).toBe(false);
  });

  it("does not touch the catalogue for a name that is already registered", async () => {
    const name = agentName("known");
    register(name, async () => "ok");

    await runAgent(name, {});

    expect(registerAllMock).not.toHaveBeenCalled();
  });
});

describe("runAgent: timeout", () => {
  it("throws AgentTimeoutError when the handler exceeds timeout_ms", async () => {
    const name = agentName("hangs");
    register(name, () => never<string>(), { timeout_ms: 20, max_retries: 0 });

    await expect(runAgent(name, {})).rejects.toBeInstanceOf(AgentTimeoutError);

    const state = getAgentState(name)!;
    expect(state.timeouts).toBe(1);
    expect(state.failures).toBe(1);
    expect(state.last_outcome).toBe("timeout");
    expect(state.last_error).toMatch(/exceeded its 20ms timeout/);
    expect(metricValue("uros_agent_timeouts_total", { agent: name, agent_class: "general" })).toBe(1);
    expect(auditRows("AGENT_INVOCATION_FAILED")[0].reason_code).toBe("AGENT_TIMEOUT");
  });

  it("clears its deadline timer so a fast invocation is not held up by it", async () => {
    const name = agentName("fast");
    register(name, async () => "ok", { timeout_ms: 30_000 });

    const startedAt = Date.now();
    await runAgent(name, {});

    // The deadline timer is cleared in a `finally`, so a 30s timeout on a
    // 1ms invocation costs nothing — and leaves no handle to keep the
    // event loop (or this test process) alive.
    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(getAgentState(name)!.successes).toBe(1);
  });

  it("a timed-out attempt is classified transient and retried up to max_retries", async () => {
    const name = agentName("slow-then-fast");
    let calls = 0;
    register(
      name,
      async () => {
        calls += 1;
        if (calls < 3) return never<string>();
        return "recovered";
      },
      { timeout_ms: 10, max_retries: 3, backoff_base_ms: 2, backoff_max_ms: 100 }
    );

    await expect(runAgent(name, {})).resolves.toBe("recovered");

    expect(calls).toBe(3);
    const state = getAgentState(name)!;
    expect(state.timeouts).toBe(2);
    expect(state.retries).toBe(2);
    expect(state.successes).toBe(1);
    expect(state.failures).toBe(0);
    expect(auditRows("AGENT_INVOCATION_RETRY").map((r) => r.reason_code)).toEqual(["AGENT_TIMEOUT", "AGENT_TIMEOUT"]);
    expect(metricValue("uros_agent_retries_total", { agent: name, agent_class: "general" })).toBe(2);
  });
});

describe("runAgent: retry with exponential backoff", () => {
  it("retries transient failures and succeeds without the caller seeing them", async () => {
    const name = agentName("flaky");
    let calls = 0;
    register(
      name,
      async () => {
        calls += 1;
        if (calls < 3) throw Object.assign(new Error("connection terminated unexpectedly"), { code: "ECONNRESET" });
        return "ok-after-retries";
      },
      { max_retries: 3, backoff_base_ms: 10, backoff_max_ms: 1_000 }
    );

    await expect(runAgent(name, {})).resolves.toBe("ok-after-retries");

    expect(calls).toBe(3);
    // Exponential: base * 2^attempt, i.e. 10ms then 20ms.
    expect(sleepSpy.mock.calls.map((c) => c[0])).toEqual([10, 20]);
    expect(getAgentState(name)!.retries).toBe(2);
    expect(auditActions()).toEqual([
      "AGENT_INVOCATION_STARTED",
      "AGENT_INVOCATION_RETRY",
      "AGENT_INVOCATION_RETRY",
      "AGENT_INVOCATION_SUCCEEDED",
    ]);
    expect(auditRows("AGENT_INVOCATION_RETRY")[0].reason_code).toBe("AGENT_TRANSIENT_FAILURE");
  });

  it("caps backoff at backoff_max_ms", async () => {
    const name = agentName("always-flaky");
    register(
      name,
      async (): Promise<string> => {
        throw Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
      },
      // Threshold above the attempt count so this test measures the backoff
      // schedule alone; the mid-invocation trip is asserted separately below.
      { max_retries: 3, backoff_base_ms: 100, backoff_max_ms: 150, circuit_failure_threshold: 10 }
    );

    await expect(runAgent(name, {})).rejects.toThrow("socket hang up");

    expect(sleepSpy.mock.calls.map((c) => c[0])).toEqual([100, 150, 150]);
  });

  it("stops a retry storm mid-invocation once the breaker trips", async () => {
    const name = agentName("retry-storm");
    const handler = jest.fn(async (): Promise<string> => {
      throw Object.assign(new Error("temporarily unavailable"), { code: "ECONNREFUSED" });
    });
    register(name, handler, { max_retries: 10, backoff_base_ms: 1, circuit_failure_threshold: 2 });

    // The gate is checked per attempt, not once per invocation: two
    // consecutive failures open the circuit and the third attempt is
    // refused outright instead of sleeping and hammering a dead dependency.
    await expect(runAgent(name, {})).rejects.toBeInstanceOf(AgentCircuitOpenError);

    expect(handler).toHaveBeenCalledTimes(2);
    // Two backoff sleeps: one after each failed attempt. The second is spent
    // before the gate is re-checked, so the retry storm ends one sleep later
    // than the trip itself — bounded, and never another call to the agent.
    expect(sleepSpy).toHaveBeenCalledTimes(2);
    expect(getAgentState(name)!.retries).toBe(2);
    expect(getAgentState(name)!.circuit.state).toBe("OPEN");
    expect(getAgentState(name)!.last_outcome).toBe("circuit_open");
  });

  it("never retries a permanent failure: the agent is called exactly once", async () => {
    const name = agentName("permanent");
    const handler = jest.fn(async (): Promise<string> => {
      throw new Error("Candidate UROS-9 not found");
    });
    register(name, handler, { max_retries: 5 });

    await expect(runAgent(name, {})).rejects.toThrow("Candidate UROS-9 not found");

    expect(handler).toHaveBeenCalledTimes(1);
    expect(sleepSpy).not.toHaveBeenCalled();
    expect(getAgentState(name)).toMatchObject({ failures: 1, retries: 0, successes: 0, last_outcome: "failure" });
    expect(auditActions()).toEqual(["AGENT_INVOCATION_STARTED", "AGENT_INVOCATION_FAILED"]);
    expect(auditRows("AGENT_INVOCATION_FAILED")[0].reason_code).toBe("AGENT_FAILURE");
    // The record states what actually happened, not the retry budget.
    expect(auditRows("AGENT_INVOCATION_FAILED")[0].input_value).toMatchObject({ attempts: 1, max_attempts: 6 });
  });

  it("surfaces the agent's own error object so route-level error mapping still works", async () => {
    class NotFound extends Error {
      readonly statusCode = 404;
    }
    const name = agentName("typed-error");
    register(name, async (): Promise<string> => {
      throw new NotFound("Circular has not received this candidate");
    });

    const err = await runAgent(name, {}).catch((e) => e);
    expect(err).toBeInstanceOf(NotFound);
    expect((err as NotFound).statusCode).toBe(404);
  });

  it("honours a per-agent transient classifier override", async () => {
    const name = agentName("custom-classifier");
    let calls = 0;
    registerAgent({
      name,
      agent_class: "general",
      handler: async () => {
        calls += 1;
        if (calls < 2) throw new Error("upstream said: try again later");
        return "ok";
      },
      options: { ...FAST, max_retries: 2, backoff_base_ms: 1 },
      // The default classifier would treat this as permanent; this agent knows better.
      isTransient: (err) => err instanceof Error && err.message.includes("try again later"),
    });

    await expect(runAgent(name, {})).resolves.toBe("ok");
    expect(calls).toBe(2);
  });

  it("logs every failed attempt with request_id, agent_name and the retry decision", async () => {
    const name = agentName("noisy");
    register(
      name,
      async (): Promise<string> => {
        throw Object.assign(new Error("temporarily unavailable"), { code: "ECONNREFUSED" });
      },
      { max_retries: 1, backoff_base_ms: 1 }
    );

    await expect(runAgent(name, {}, { request_id: "req-noisy" })).rejects.toThrow();

    const attemptLogs = (logger.warn as jest.Mock).mock.calls.filter((c) => c[0] === "AGENT_INVOCATION_ATTEMPT_FAILED");
    expect(attemptLogs).toHaveLength(2);
    expect(attemptLogs[0][1]).toMatchObject({ request_id: "req-noisy", agent_name: name, attempt: 0, transient: true, will_retry: true });
    expect(attemptLogs[1][1]).toMatchObject({ attempt: 1, transient: true, will_retry: false });
    const failureLogs = (logger.error as jest.Mock).mock.calls.filter((c) => c[0] === "AGENT_INVOCATION_FAILED");
    expect(failureLogs).toHaveLength(1);
    expect(failureLogs[0][1]).toMatchObject({ request_id: "req-noisy", agent_name: name, attempts: 2, max_attempts: 2 });
  });
});

describe("runAgent: circuit breaker", () => {
  it("opens after N consecutive failures and then rejects without calling the agent", async () => {
    const name = agentName("trips");
    const handler = jest.fn(async (): Promise<string> => {
      throw new Error("downstream refused");
    });
    register(name, handler, { circuit_failure_threshold: 3, circuit_reset_ms: 60_000 });

    for (let i = 0; i < 3; i++) {
      await expect(runAgent(name, {})).rejects.toThrow("downstream refused");
    }
    expect(handler).toHaveBeenCalledTimes(3);
    expect(getAgentState(name)!.circuit.state).toBe("OPEN");

    // The whole point: a known-broken dependency is not hammered again.
    const err = await runAgent(name, {}).catch((e) => e);
    expect(err).toBeInstanceOf(AgentCircuitOpenError);
    expect((err as AgentCircuitOpenError).retry_after_ms).toBeGreaterThan(0);
    expect(handler).toHaveBeenCalledTimes(3);
    expect(getAgentState(name)!.last_outcome).toBe("circuit_open");

    expect(metricValue("uros_agent_circuit_open_total", { agent: name, agent_class: "general" })).toBe(1);
    expect(metricValue("uros_agent_circuit_state", { agent: name })).toBe(2);
    expect(metricValue("uros_agent_invocations_total", { agent: name, agent_class: "general", outcome: "circuit_open" })).toBe(1);
    expect(auditActions()).toContain("AGENT_CIRCUIT_OPEN");
    expect(auditRows("AGENT_CIRCUIT_REJECTED")[0].reason_code).toBe("AGENT_CIRCUIT_OPEN");
    expect((logger.warn as jest.Mock).mock.calls.some((c) => c[0] === "AGENT_INVOCATION_REJECTED_CIRCUIT_OPEN")).toBe(true);
  });

  it("a rejected call is not retried, even for a transient-looking error", async () => {
    const name = agentName("rejected-no-retry");
    register(name, async (): Promise<string> => {
      throw new Error("downstream refused");
    }, { circuit_failure_threshold: 1, circuit_reset_ms: 60_000, max_retries: 5 });

    await expect(runAgent(name, {})).rejects.toThrow("downstream refused");
    await expect(runAgent(name, {})).rejects.toBeInstanceOf(AgentCircuitOpenError);

    // The rejection path must never sleep-and-retry: it is a fast failure.
    expect(sleepSpy).not.toHaveBeenCalled();
    expect(isTransientError(new AgentCircuitOpenError(name, 1_000))).toBe(false);
  });

  it("half-open probe: a success closes the circuit and normal service resumes", async () => {
    const name = agentName("recovers");
    let fail = true;
    register(
      name,
      async (): Promise<string> => {
        if (fail) throw new Error("downstream refused");
        return "back-online";
      },
      { circuit_failure_threshold: 1, circuit_reset_ms: 25 }
    );

    await expect(runAgent(name, {})).rejects.toThrow();
    expect(getAgentState(name)!.circuit.state).toBe("OPEN");
    await expect(runAgent(name, {})).rejects.toBeInstanceOf(AgentCircuitOpenError);

    fail = false;
    await sleep(40); // reset window elapses; the next call is admitted as a probe

    await expect(runAgent(name, {})).resolves.toBe("back-online");
    expect(getAgentState(name)!.circuit.state).toBe("CLOSED");
    expect(getAgentState(name)!.circuit.consecutiveFailures).toBe(0);
    expect(auditActions()).toContain("AGENT_CIRCUIT_HALF_OPEN");
    expect(auditActions()).toContain("AGENT_CIRCUIT_CLOSED");
    expect(metricValue("uros_agent_circuit_state", { agent: name })).toBe(0);

    // And it keeps working: the breaker is genuinely closed, not merely quiet.
    await expect(runAgent(name, {})).resolves.toBe("back-online");
  });

  it("half-open probe: a failure re-opens the circuit for another full window", async () => {
    const name = agentName("probe-fails");
    register(
      name,
      async (): Promise<string> => {
        throw new Error("still down");
      },
      { circuit_failure_threshold: 1, circuit_reset_ms: 25 }
    );

    await expect(runAgent(name, {})).rejects.toThrow("still down");
    await sleep(40);
    await expect(runAgent(name, {})).rejects.toThrow("still down"); // admitted probe, failed
    expect(getAgentState(name)!.circuit.state).toBe("OPEN");
    expect(getAgentState(name)!.circuit.snapshot().total_open_events).toBe(2);
    // Immediately re-opens: no second probe inside the new window.
    await expect(runAgent(name, {})).rejects.toBeInstanceOf(AgentCircuitOpenError);
  });

  it("successes between failures reset the consecutive counter so the circuit never opens", async () => {
    const name = agentName("intermittent");
    let fail = false;
    register(
      name,
      async (): Promise<string> => {
        if (fail) throw new Error("blip");
        return "ok";
      },
      { circuit_failure_threshold: 2 }
    );

    for (let i = 0; i < 5; i++) {
      fail = true;
      await expect(runAgent(name, {})).rejects.toThrow("blip");
      fail = false;
      await expect(runAgent(name, {})).resolves.toBe("ok");
    }

    expect(getAgentState(name)!.circuit.state).toBe("CLOSED");
    expect(getAgentState(name)!.failures).toBe(5);
    expect(getAgentState(name)!.successes).toBe(5);
    expect(metricValue("uros_agent_circuit_open_total", { agent: name, agent_class: "general" })).toBeNull();
  });
});

describe("enqueueAgent: worker-pool dispatch", () => {
  it("runs the invocation on the class pool and resolves with its result", async () => {
    const name = agentName("pooled");
    register(name, async (input: { n: number }) => input.n + 1);

    await expect(enqueueAgent<{ n: number }, number>(name, { n: 41 })).resolves.toBe(42);

    const pool = getPoolForClass("general");
    expect(pool.snapshot()).toMatchObject({ completed: 1, failed: 0, active: 0, queued: 0 });
    expect(getAgentState(name)!.successes).toBe(1);
  });

  it("bounds concurrency to the configured pool size, queueing the rest", async () => {
    const name = agentName("bounded");
    let active = 0;
    let peak = 0;
    register(name, async () => {
      active += 1;
      peak = Math.max(peak, active);
      await sleep(20);
      active -= 1;
      return "done";
    });

    const pool = getPoolForClass("general");
    const size = pool.size;
    expect(size).toBe(env.AGENT_POOL_GENERAL_SIZE);
    expect(size).toBeGreaterThan(1);

    await Promise.all(Array.from({ length: size * 3 }, () => enqueueAgent(name, {})));

    expect(peak).toBeLessThanOrEqual(size);
    expect(peak).toBeGreaterThan(1);
    expect(pool.snapshot().completed).toBe(size * 3);
  });

  it("rejects with AgentNotRegisteredError for an unknown name", async () => {
    await expect(enqueueAgent("test.not.registered.at.all", {})).rejects.toBeInstanceOf(AgentNotRegisteredError);
  });
});

describe("registration and defaults", () => {
  it("lists every registered agent name for /health to enumerate", () => {
    register("test.alpha", async () => 1);
    register("test.beta", async () => 2);
    expect(listAgentNames()).toEqual(expect.arrayContaining(["test.alpha", "test.beta"]));
  });

  it("re-registering a name swaps the handler but preserves the tripped breaker", async () => {
    const name = agentName("hot-swap");
    register(name, async (): Promise<string> => {
      throw new Error("v1 broken");
    }, { circuit_failure_threshold: 1 });

    await expect(runAgent(name, {})).rejects.toThrow("v1 broken");
    expect(getAgentState(name)!.circuit.state).toBe("OPEN");

    const v2 = jest.fn(async (_input: unknown) => "v2 ok");
    register(name, v2, { circuit_failure_threshold: 1 });

    // A deploy must not silently clear a breaker that just tripped.
    await expect(runAgent(name, {})).rejects.toBeInstanceOf(AgentCircuitOpenError);
    expect(v2).not.toHaveBeenCalled();
    expect(getAgentState(name)!.invocations).toBe(2);
  });

  it("derives its defaults from validated environment configuration", () => {
    const options = defaultRunnerOptions();
    expect(options.timeout_ms).toBeGreaterThan(0);
    expect(options.max_retries).toBeGreaterThanOrEqual(0);
    expect(options.backoff_base_ms).toBeGreaterThanOrEqual(0);
    expect(options.backoff_max_ms).toBeGreaterThanOrEqual(options.backoff_base_ms);
    expect(options.circuit_failure_threshold).toBeGreaterThan(0);
    expect(options.circuit_reset_ms).toBeGreaterThan(0);
    expect(typeof options.audit).toBe("boolean");
  });
});

describe("transient-error classification and backoff (pure functions)", () => {
  it("treats connection, serialization and 5xx conditions as transient", () => {
    expect(isTransientError(Object.assign(new Error("x"), { code: "ECONNRESET" }))).toBe(true);
    expect(isTransientError(Object.assign(new Error("x"), { code: "40001" }))).toBe(true);
    expect(isTransientError(Object.assign(new Error("x"), { code: "40P01" }))).toBe(true);
    expect(isTransientError(Object.assign(new Error("x"), { code: "53300" }))).toBe(true);
    expect(isTransientError(Object.assign(new Error("x"), { status: 503 }))).toBe(true);
    expect(isTransientError(Object.assign(new Error("x"), { retryable: true }))).toBe(true);
    expect(isTransientError(new AgentTimeoutError("a", 10))).toBe(true);
  });

  it("treats business and programming errors as permanent", () => {
    expect(isTransientError(new Error("Candidate not found"))).toBe(false);
    expect(isTransientError(new Error("circular has not received this candidate"))).toBe(false);
    expect(isTransientError(Object.assign(new Error("x"), { status: 409 }))).toBe(false);
    expect(isTransientError(Object.assign(new Error("x"), { code: "23505" }))).toBe(false);
    expect(isTransientError(Object.assign(new Error("x"), { retryable: false, code: "ECONNRESET" }))).toBe(false);
    expect(isTransientError("plain string")).toBe(false);
    expect(isTransientError(null)).toBe(false);
  });

  it("computes exponential backoff with a ceiling and never a negative delay", () => {
    expect(computeBackoffMs(0, 100, 5_000)).toBe(100);
    expect(computeBackoffMs(1, 100, 5_000)).toBe(200);
    expect(computeBackoffMs(2, 100, 5_000)).toBe(400);
    expect(computeBackoffMs(10, 100, 5_000)).toBe(5_000);
    expect(computeBackoffMs(0, 0, 5_000)).toBe(0);
    expect(computeBackoffMs(-1, 100, 5_000)).toBe(100);
  });
});
