/**
 * Per-candidate / per-item error isolation.
 *
 * Deliverable: a batch must never lose every result because one item blew
 * up. Tested at two levels, because UROS guarantees it at two levels:
 *
 *  1. `runBatchIsolated` — the infrastructure primitive. Any batch loop
 *     routed through it gets catch-log-flag-continue for free.
 *  2. Two real batch agents (`fraud_detection.runFraudDetectionBatch` and
 *     `rediscovery.sendOutreachBatch`), invoked through the generic runner,
 *     with a failure injected at the database layer for one specific item.
 *     These are the agents' own isolation, unchanged by the hardening —
 *     the tests exist to prove the wrapper did not break it.
 *
 * The database is faked, not stubbed per call: one switchable in-memory fake
 * stands in for `src/database/client`, with a seam to make a single query
 * fail on a single parameter. That is the honest way to reproduce "one
 * candidate's row is unreadable" without a live Postgres.
 */
import { runBatchIsolated } from "../../../src/services/agent_runner/batch";
import { AGENT_NAMES, invoke } from "../../../src/services/agent_runner/agents";
import { runAgent } from "../../../src/services/agent_runner/runner";
import { resetAgentStates, getAgentState } from "../../../src/services/agent_runner/agent_state";
import { getPoolForClass } from "../../../src/services/agent_runner/pools";
import { metricValue } from "../../helpers/metrics_probe";

interface FakeHolder {
  current: { query: (text: string, params?: any[]) => Promise<{ rows: any[]; rowCount: number }> };
  fraud: { state: any; db: any };
  rediscovery: { state: any; db: any };
  failWhen: ((text: string, params: any[]) => boolean) | null;
  failError: Error;
}

jest.mock("../../../src/database/client", () => {
  /* eslint-disable @typescript-eslint/no-var-requires */
  const { createFakeFraudDb } = jest.requireActual("../../helpers/fake_fraud_db");
  const { createFakeRediscoveryDb } = jest.requireActual("../../helpers/fake_rediscovery_db");
  /* eslint-enable @typescript-eslint/no-var-requires */

  const fraud = createFakeFraudDb();
  const rediscovery = createFakeRediscoveryDb();
  const holder = {
    current: fraud.db,
    fraud,
    rediscovery,
    failWhen: null as ((text: string, params: any[]) => boolean) | null,
    failError: new Error("injected failure"),
  };
  (globalThis as any).__urosIsolationFakeDb = holder;

  const query = async (text: string, params: any[] = []) => {
    if (holder.failWhen && holder.failWhen(text, params)) throw holder.failError;
    return holder.current.query(text, params);
  };
  return {
    db: { query, withTransaction: async (fn: any) => holder.current.withTransaction(fn) },
    pool: { query },
  };
});

/** Read lazily: the holder exists only once something has required database/client. */
function fake(): FakeHolder {
  return (globalThis as any).__urosIsolationFakeDb as FakeHolder;
}

/** Makes exactly the queries matching `predicate` fail with `error`. */
function failQueryOn(predicate: (text: string, params: any[]) => boolean, error: Error): void {
  fake().failWhen = predicate;
  fake().failError = error;
}

function clearFailures(): void {
  fake().failWhen = null;
}

function useFraudDb(): any {
  clearFailures();
  fake().current = fake().fraud.db;
  const s = fake().fraud.state;
  for (const key of Object.keys(s)) s[key].length = 0;
  return s;
}

function useRediscoveryDb(): any {
  clearFailures();
  fake().current = fake().rediscovery.db;
  const s = fake().rediscovery.state;
  for (const key of Object.keys(s)) s[key].length = 0;
  return s;
}

/** Audit rows written through the real `logAudit`, decoded from the fake's parameter list. */
function auditRows(state: any): Array<{ entity_id: string; action: string; reason_code: string | null; reason_comment: string | null }> {
  return state.audit_log.map((row: any) => ({
    entity_type: row.params[0],
    entity_id: row.params[1],
    agent_or_user: row.params[2],
    action: row.params[3],
    reason_code: row.params[7],
    reason_comment: row.params[8],
  }));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

beforeEach(() => {
  resetAgentStates();
  clearFailures();
});

// ---------------------------------------------------------------------
// Level 1: the isolation primitive itself
// ---------------------------------------------------------------------

describe("runBatchIsolated", () => {
  it("catches a per-item error, records it, flags the item and carries on", async () => {
    const state = useFraudDb();
    const flagged: string[] = [];

    const out = await runBatchIsolated<string, string, string>({
      agentName: "test.isolated",
      items: ["a", "b", "c", "d"],
      itemKey: (item) => item,
      actor: "tester",
      request_id: "req-iso-1",
      entity_type: "CANDIDATE",
      onItemFailure: (key) => {
        flagged.push(String(key));
      },
      processItem: async (item) => {
        if (item === "c") throw new Error("malformed row");
        return item.toUpperCase();
      },
    });

    expect(out).toMatchObject({ agent_name: "test.isolated", total: 4, ok: 3, failed: 1 });
    expect(out.results.map((r) => r.result)).toEqual(["A", "B", "D"]);
    expect(out.results.map((r) => r.index)).toEqual([0, 1, 3]);
    expect(out.results.map((r) => r.key)).toEqual(["a", "b", "d"]);
    expect(out.failures).toEqual([{ key: "c", error: "malformed row" }]);
    expect(flagged).toEqual(["c"]);

    // The failure is audited against the *item*, with the reason a human needs.
    const itemFailures = auditRows(state).filter((r) => r.action === "AGENT_BATCH_ITEM_FAILED");
    expect(itemFailures).toHaveLength(1);
    expect(itemFailures[0]).toMatchObject({ entity_type: "CANDIDATE", entity_id: "c", agent_or_user: "tester", reason_code: "AGENT_ITEM_ERROR" });
    expect(itemFailures[0].reason_comment).toMatch(/malformed row/);
    expect(itemFailures[0].reason_comment).toMatch(/remaining 1 item\(s\) continued/);
  });

  it("counts per-item outcomes in the batch metrics", async () => {
    useFraudDb();
    const agent = "test.metrics-batch";

    await runBatchIsolated<string>({
      agentName: agent,
      items: ["a", "b", "c"],
      itemKey: (item) => item,
      processItem: async (item) => {
        if (item === "b") throw new Error("nope");
        return item;
      },
    });

    expect(metricValue("uros_agent_batch_items_total", { agent, status: "ok" })).toBe(2);
    expect(metricValue("uros_agent_batch_items_total", { agent, status: "failed" })).toBe(1);
  });

  it("a throwing flag hook never becomes a second failure mode", async () => {
    useFraudDb();

    const out = await runBatchIsolated<string, string, string>({
      agentName: "test.flag-throws",
      items: ["a", "b"],
      itemKey: (item) => item,
      onItemFailure: () => {
        throw new Error("flag store is down too");
      },
      processItem: async (item) => {
        if (item === "a") throw new Error("primary failure");
        return item;
      },
    });

    // The item still reports its *primary* error, and the batch still completes.
    expect(out.failures).toEqual([{ key: "a", error: "primary failure" }]);
    expect(out.ok).toBe(1);
    expect(out.results.map((r) => r.result)).toEqual(["b"]);
  });

  it("can be told not to audit per-item failures", async () => {
    const state = useFraudDb();

    const out = await runBatchIsolated<string>({
      agentName: "test.quiet",
      items: ["a"],
      itemKey: (item) => item,
      auditFailures: false,
      processItem: async () => {
        throw new Error("boom");
      },
    });

    expect(out.failed).toBe(1);
    expect(auditRows(state).filter((r) => r.action === "AGENT_BATCH_ITEM_FAILED")).toHaveLength(0);
  });

  it("preserves input order and bounds concurrency when run through the class pool", async () => {
    useFraudDb();
    const poolSize = getPoolForClass("scoring").size;
    let active = 0;
    let peak = 0;

    const out = await runBatchIsolated<number, string, number>({
      agentName: "test.concurrent",
      agentClass: "scoring",
      items: Array.from({ length: 12 }, (_, i) => i),
      itemKey: (item) => `item-${item}`,
      concurrency: 8,
      processItem: async (item) => {
        active += 1;
        peak = Math.max(peak, active);
        await sleep(5);
        active -= 1;
        if (item === 7) throw new Error("bad item 7");
        return item * 2;
      },
    });

    expect(out.results.map((r) => r.result)).toEqual([0, 2, 4, 6, 8, 10, 12, 16, 18, 20, 22]);
    expect(out.results.map((r) => r.index)).toEqual([0, 1, 2, 3, 4, 5, 6, 8, 9, 10, 11]);
    expect(out.failures).toEqual([{ key: "item-7", error: "bad item 7" }]);
    // Throughput is raised, but never past the configured pool (and therefore
    // never past DB_POOL_MAX): this is what keeps large batches safe to run.
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(poolSize);
  });

  it("an empty batch is a well-formed no-op", async () => {
    useFraudDb();
    const out = await runBatchIsolated<string>({
      agentName: "test.empty",
      items: [],
      itemKey: (item) => item,
      processItem: async () => "never",
    });
    expect(out).toMatchObject({ total: 0, ok: 0, failed: 0, results: [], failures: [] });
  });
});

// ---------------------------------------------------------------------
// Level 2: real batch agents, through the generic runner
// ---------------------------------------------------------------------

const ORG = "org-1";

function seedFraudCandidate(state: any, id: string, overrides: Record<string, any> = {}) {
  state.candidates.push({
    candidate_id: id,
    org_id: ORG,
    full_name: `Candidate ${id}`,
    date_of_birth: "1990-01-01",
    national_id: `NID-${id}`,
    phone_primary: `017${id.slice(-8)}`,
    email: `${id}@example.com`,
    job_circular_id: "CIRC-1",
    created_at: "2026-01-01T00:00:00Z",
    ...overrides,
  });
  state.candidate_academic_records.push({
    candidate_id: id,
    level: "Bachelor",
    passing_year: 2011,
    division_class: "First",
    cgpa: 3.8,
    result_scale: "out of 4",
  });
}

describe("fraud detection: per-candidate isolation", () => {
  it("runFraudDetectionBatch reports the failing candidate and still checks every other one", async () => {
    const state = useFraudDb();
    seedFraudCandidate(state, "UROS-1");
    seedFraudCandidate(state, "UROS-2", { national_id: "NID-UROS-1" }); // duplicate identity of UROS-1
    seedFraudCandidate(state, "UROS-3");

    // One candidate's row becomes unreadable mid-batch.
    failQueryOn(
      (text, params) => text.includes("FROM candidates WHERE candidate_id=$1 AND org_id=$2") && params[0] === "UROS-2",
      new Error("injected: candidate row unreadable")
    );

    const results = await invoke(AGENT_NAMES.FRAUD_DETECTION_BATCH, {
      candidate_ids: ["UROS-1", "UROS-2", "UROS-3"],
      org_id: ORG,
      actor_user_id: "user-1",
    });

    expect(results).toHaveLength(3);
    expect(results.map((r) => r.candidate_id)).toEqual(["UROS-1", "UROS-2", "UROS-3"]);

    const broken = results.find((r) => r.candidate_id === "UROS-2")!;
    expect(broken.error).toMatch(/injected: candidate row unreadable/);
    expect(broken.checks_run).toBe(0);
    expect(broken.flags_created).toEqual([]);

    // The other two were fully evaluated despite the failure between them.
    for (const id of ["UROS-1", "UROS-3"]) {
      const r = results.find((x) => x.candidate_id === id)!;
      expect(r.error).toBeUndefined();
      expect(r.checks_run).toBeGreaterThan(0);
    }
    // The duplicate-identity check still fired for the survivor.
    expect(results.find((r) => r.candidate_id === "UROS-1")!.flags_created.some((f) => f.check_type === "DUPLICATE_IDENTITY")).toBe(true);

    // The runner saw one successful batch invocation — isolation means the
    // agent never threw, so no retry and no circuit damage.
    expect(getAgentState(AGENT_NAMES.FRAUD_DETECTION_BATCH)).toMatchObject({ invocations: 1, successes: 1, failures: 0, retries: 0 });
    expect(getAgentState(AGENT_NAMES.FRAUD_DETECTION_BATCH)!.circuit.state).toBe("CLOSED");
  });

  it("runBatchIsolated around the single-candidate agent keeps the batch alive when the agent itself throws", async () => {
    const state = useFraudDb();
    seedFraudCandidate(state, "UROS-1");
    seedFraudCandidate(state, "UROS-3");
    const flagged: string[] = [];

    const out = await runBatchIsolated<string, string, unknown>({
      agentName: AGENT_NAMES.FRAUD_DETECTION_FOR_CANDIDATE,
      agentClass: "verification",
      items: ["UROS-1", "UROS-MISSING", "UROS-3"],
      itemKey: (id) => id,
      actor: "user-1",
      request_id: "req-fraud-iso",
      entity_type: "CANDIDATE",
      onItemFailure: (key) => {
        flagged.push(String(key));
      },
      processItem: (id) =>
        runAgent<{ candidate_id: string; org_id: string; actor_user_id: string }, { candidate_id: string; checks_run: number }>(
          AGENT_NAMES.FRAUD_DETECTION_FOR_CANDIDATE,
          { candidate_id: id, org_id: ORG, actor_user_id: "user-1" },
          { actor: "user-1", entity_type: "CANDIDATE", entity_id: id, request_id: "req-fraud-iso" }
        ),
    });

    expect(out.total).toBe(3);
    expect(out.ok).toBe(2);
    expect(out.failed).toBe(1);
    expect(out.failures).toEqual([{ key: "UROS-MISSING", error: "Candidate not found: UROS-MISSING" }]);
    expect(out.results.map((r) => r.key)).toEqual(["UROS-1", "UROS-3"]);
    expect(flagged).toEqual(["UROS-MISSING"]);
    expect(auditRows(state).filter((r) => r.action === "AGENT_BATCH_ITEM_FAILED").map((r) => r.entity_id)).toEqual(["UROS-MISSING"]);
  });
});

describe("rediscovery outreach: per-item isolation", () => {
  function seedSuggestion(state: any, suggestionId: string, candidateId: string, status = "APPROVED") {
    state.candidates.push({
      candidate_id: candidateId,
      org_id: ORG,
      full_name: `Candidate ${candidateId}`,
      preferred_language: null,
    });
    if (state.organizations.length === 0) state.organizations.push({ org_id: ORG, default_language: "en" });
    state.rediscovery_consents.push({
      consent_id: `consent-${candidateId}`,
      candidate_id: candidateId,
      org_id: ORG,
      opted_in: true,
      opted_in_at: "2026-01-01T00:00:00.000Z",
      opted_out_at: null,
    });
    state.rediscovery_suggestions.push({
      suggestion_id: suggestionId,
      org_id: ORG,
      candidate_id: candidateId,
      target_circular_id: "CIRC-NEW",
      target_position: "Officer",
      fit_score: 82,
      reason_code: "REDISCOVERY_SUGGESTED",
      reason_description: "Fits the persona",
      evidence: {},
      status,
      created_at: "2026-01-01T00:00:00.000Z",
    });
  }

  it("sends the rest of the batch and reports the failed suggestion in `skipped`", async () => {
    const state = useRediscoveryDb();
    seedSuggestion(state, "sug-1", "C1");
    seedSuggestion(state, "sug-2", "C2");
    seedSuggestion(state, "sug-3", "C3");

    failQueryOn(
      (text, params) => text.includes("FROM rediscovery_consents WHERE candidate_id=$1") && params[0] === "C2",
      new Error("injected: consent store unavailable")
    );

    const out = await invoke(AGENT_NAMES.REDISCOVERY_SEND_OUTREACH, {
      suggestion_ids: ["sug-1", "sug-2", "sug-3"],
      channel: "SMS",
      template_code: "REDISCOVERY_INVITE",
      org_id: ORG,
      actor_user_id: "user-1",
    });

    // sug-1 and sug-3 still went out — the failure in the middle did not abort the batch.
    expect(out.sent.map((o) => o.suggestion_id)).toEqual(["sug-1", "sug-3"]);
    expect(state.rediscovery_outreach).toHaveLength(2);
    expect(state.communication_log.map((c: any) => c.candidate_id)).toEqual(["C1", "C3"]);

    // The failed item is reported to the human in the same list the UI already renders.
    expect(out.skipped).toHaveLength(1);
    expect(out.skipped[0].suggestion_id).toBe("sug-2");
    expect(out.skipped[0].reason).toMatch(/Send failed: injected: consent store unavailable/);

    // And it is audited, so the omission is traceable rather than silent.
    const failures = auditRows(state).filter((r) => r.action === "REDISCOVERY_OUTREACH_FAILED");
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({ entity_id: "sug-2", reason_code: "REDISCOVERY_ITEM_ERROR" });
    expect(failures[0].reason_comment).toMatch(/remaining suggestions continued/);

    expect(getAgentState(AGENT_NAMES.REDISCOVERY_SEND_OUTREACH)).toMatchObject({ invocations: 1, successes: 1, failures: 0 });
  });

  it("keeps the pre-existing business skips distinct from infrastructure failures", async () => {
    const state = useRediscoveryDb();
    seedSuggestion(state, "sug-ok", "C-OK");
    seedSuggestion(state, "sug-pending", "C-PENDING", "PENDING_REVIEW");

    const out = await invoke(AGENT_NAMES.REDISCOVERY_SEND_OUTREACH, {
      suggestion_ids: ["sug-pending", "sug-ok", "sug-missing"],
      channel: "SMS",
      template_code: "REDISCOVERY_INVITE",
      org_id: ORG,
      actor_user_id: "user-1",
    });

    expect(out.sent.map((o) => o.suggestion_id)).toEqual(["sug-ok"]);
    expect(out.skipped).toEqual([
      { suggestion_id: "sug-pending", reason: "Suggestion status is PENDING_REVIEW, not APPROVED" },
      { suggestion_id: "sug-missing", reason: "Suggestion not found" },
    ]);
  });
});
