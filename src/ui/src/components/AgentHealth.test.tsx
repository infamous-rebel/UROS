import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import type { AgentHealthEntry, HealthResponse } from "../api/client";

let mockHealth: { data: HealthResponse | undefined; isLoading: boolean; isError: boolean };

vi.mock("../api/hooks", () => ({
  useHealth: () => mockHealth,
}));

import { AgentHealth } from "./AgentHealth";

function agent(overrides: Partial<AgentHealthEntry> = {}): AgentHealthEntry {
  return {
    agent_name: "scoring.compute",
    agent_class: "scoring",
    circuit_state: "CLOSED",
    consecutive_failures: 0,
    circuit_retry_after_ms: 0,
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
    status: "idle",
    queue_depth: 0,
    queue_active: 0,
    pool_size: 4,
    ...overrides,
  };
}

/** Builds a payload whose totals are derived from the agents, exactly as the API does. */
function health(agents: AgentHealthEntry[], extra: Partial<HealthResponse> = {}): HealthResponse {
  const sum = (pick: (a: AgentHealthEntry) => number) => agents.reduce((total, a) => total + pick(a), 0);
  return {
    status: "ok",
    deployment_mode: "saas",
    agent_health: {
      agents,
      pools: [],
      totals: {
        agents: agents.length,
        invocations: sum((a) => a.invocations),
        successes: sum((a) => a.successes),
        failures: sum((a) => a.failures),
        retries: sum((a) => a.retries),
        timeouts: sum((a) => a.timeouts),
        circuits_open: agents.filter((a) => a.circuit_state === "OPEN").length,
        queued: sum((a) => a.queue_depth),
      },
    },
    ...extra,
  };
}

function setHealth(data: HealthResponse | undefined, opts: { isLoading?: boolean; isError?: boolean } = {}): void {
  mockHealth = { data, isLoading: opts.isLoading ?? false, isError: opts.isError ?? false };
}

const LAST_OK = "2026-09-12T10:15:30.000Z";
const LAST_FAIL = "2026-09-12T10:19:05.000Z";

describe("AgentHealth", () => {
  beforeEach(() => {
    setHealth(undefined);
  });

  it("says it is loading rather than rendering an empty grid", () => {
    setHealth(undefined, { isLoading: true });
    render(<AgentHealth />);
    expect(screen.getByText("Loading agent runtime status…")).toBeInTheDocument();
  });

  it("reports an unreachable /health endpoint as an error, not as silence", () => {
    setHealth(undefined, { isError: true });
    render(<AgentHealth />);
    expect(screen.getByText("Could not reach the /health endpoint.")).toBeInTheDocument();
  });

  it("handles an API build that predates per-agent health", () => {
    setHealth({ status: "ok", deployment_mode: "saas" });
    render(<AgentHealth />);
    expect(screen.getByText("This API build does not report per-agent health yet.")).toBeInTheDocument();
  });

  it("handles a process that has registered no agents", () => {
    setHealth(health([]));
    render(<AgentHealth />);
    expect(screen.getByText("No agents registered in this process yet.")).toBeInTheDocument();
  });

  it("summarises an all-healthy fleet in one line and lists every agent on request", () => {
    setHealth(
      health([
        agent({ agent_name: "intake.fetch", status: "idle" }),
        agent({
          agent_name: "parser.extract_fields",
          agent_class: "parser",
          status: "healthy",
          invocations: 12,
          successes: 12,
          last_success_at: LAST_OK,
        }),
        agent({ agent_name: "scoring.compute", status: "healthy", invocations: 4, successes: 4, last_success_at: LAST_OK }),
      ])
    );
    render(<AgentHealth />);

    expect(screen.getByText("3 agents · 0 open · 0 queued")).toBeInTheDocument();
    expect(screen.getByText("All 3 agents healthy — no circuit open, no queue backlog.")).toBeInTheDocument();
    // Idle rows would be dead space that hides a real problem.
    expect(screen.queryByText("intake.fetch")).not.toBeInTheDocument();
    expect(screen.queryByText("parser.extract_fields")).not.toBeInTheDocument();

    fireEvent.click(screen.getByText("Show all 3 agents"));
    expect(screen.getByText("intake.fetch")).toBeInTheDocument();
    expect(screen.getByText("parser.extract_fields")).toBeInTheDocument();
    expect(screen.getByText("scoring.compute")).toBeInTheDocument();
    // Both invoked agents show the same shape of row: last success, no
    // failure, nothing waiting.
    expect(
      screen.getAllByText(`last ok ${new Date(LAST_OK).toLocaleTimeString()} · last fail — · queue 0/4`)
    ).toHaveLength(2);
    expect(screen.queryByText(/All 3 agents healthy/)).not.toBeInTheDocument();

    fireEvent.click(screen.getByText("Show only agents needing attention (0)"));
    expect(screen.queryByText("intake.fetch")).not.toBeInTheDocument();
  });

  it("surfaces an open circuit with last success, last failure, queue depth and the reason", () => {
    setHealth(
      health([
        agent({ agent_name: "intake.fetch", status: "idle" }),
        agent({
          agent_name: "exam_scanner.ingest_file",
          agent_class: "scanner",
          status: "unavailable",
          circuit_state: "OPEN",
          consecutive_failures: 5,
          circuit_retry_after_ms: 24_000,
          invocations: 9,
          successes: 4,
          failures: 5,
          retries: 3,
          timeouts: 5,
          last_success_at: LAST_OK,
          last_failure_at: LAST_FAIL,
          last_error: "Agent 'exam_scanner.ingest_file' exceeded its 30000ms timeout",
          queue_depth: 2,
          queue_active: 2,
          pool_size: 2,
        }),
      ])
    );
    render(<AgentHealth />);

    expect(screen.getByText("2 agents · 1 open · 2 queued")).toBeInTheDocument();
    expect(screen.getByText("exam_scanner.ingest_file")).toBeInTheDocument();
    expect(screen.getByText("OPEN")).toBeInTheDocument();
    expect(
      screen.getByText(
        `last ok ${new Date(LAST_OK).toLocaleTimeString()} · last fail ${new Date(LAST_FAIL).toLocaleTimeString()} · queue 2/2`
      )
    ).toBeInTheDocument();
    expect(screen.getByText("9 calls · 5 failed · 3 retried · 5 timed out")).toBeInTheDocument();
    expect(screen.getByText("Agent 'exam_scanner.ingest_file' exceeded its 30000ms timeout")).toBeInTheDocument();
    // The idle agent is counted, not listed.
    expect(screen.queryByText("intake.fetch")).not.toBeInTheDocument();
    expect(screen.getByText("1 healthy or idle agent(s) hidden.")).toBeInTheDocument();
  });

  it("orders the worst agent first and surfaces a queue backlog on an otherwise healthy agent", () => {
    setHealth(
      health([
        agent({ agent_name: "aaa.healthy", status: "healthy", invocations: 3, successes: 3 }),
        agent({ agent_name: "bbb.busy", status: "healthy", invocations: 6, successes: 6, queue_depth: 7, queue_active: 4 }),
        agent({ agent_name: "ccc.degraded", status: "degraded", circuit_state: "HALF_OPEN", failures: 2, invocations: 5, successes: 3 }),
        agent({ agent_name: "ddd.unavailable", status: "unavailable", circuit_state: "OPEN", failures: 5, invocations: 5 }),
      ])
    );
    render(<AgentHealth />);

    expect(screen.getByText("4 agents · 1 open · 7 queued")).toBeInTheDocument();
    expect(screen.getByText("ddd.unavailable")).toBeInTheDocument();
    expect(screen.getByText("ccc.degraded")).toBeInTheDocument();
    expect(screen.getByText("HALF_OPEN")).toBeInTheDocument();
    // A backlog on a healthy agent still matters: it is throughput, not failure.
    expect(screen.getByText("bbb.busy")).toBeInTheDocument();
    expect(screen.getByText(/queue 7\/4/)).toBeInTheDocument();
    // The healthy, unbacked-up agent stays out of the list.
    expect(screen.queryByText("aaa.healthy")).not.toBeInTheDocument();

    fireEvent.click(screen.getByText("Show all 4 agents"));
    const names = screen.getAllByText(/^[a-d]{3}\./).map((el) => el.textContent);
    expect(names).toEqual(["ddd.unavailable", "ccc.degraded", "aaa.healthy", "bbb.busy"]);
  });
});
