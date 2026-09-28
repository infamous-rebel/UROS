/**
 * Restart simulation: a long-running batch must survive its own process
 * dying, and finish the remainder rather than starting over.
 *
 * The database is an in-memory fake of `agent_batch_progress` (migration
 * 0028) that enforces the table's CHECK constraints and owns a controllable
 * clock, so "the owner died five minutes ago" and "migration not applied"
 * are both reproducible without Postgres. See
 * tests/helpers/fake_agent_runtime_db.ts.
 *
 * A crash is simulated the only honest way available in-process: the batch
 * coroutine is abandoned mid-item (its `processItem` never returns) and the
 * test races against an external rejection. No `finally` runs, no status is
 * written — exactly what SIGKILL leaves behind.
 */
import {
  listActiveBatchKeys,
  loadBatchProgress,
  markBatchInterrupted,
  recoverInterruptedBatches,
  runResumableBatch,
} from "../../src/services/agent_runner/batch";
import {
  gracefulShutdown,
  interruptActiveBatches,
  resetSupervisorForTests,
  supervise,
} from "../../src/services/agent_runner/supervisor";
import { resetPools } from "../../src/services/agent_runner/pools";
import { logger } from "../../src/utils/logger";
import { metricValue } from "../helpers/metrics_probe";
import type { FakeAgentRuntimeDb } from "../helpers/fake_agent_runtime_db";

jest.mock("../../src/database/client", () => {
  /* eslint-disable @typescript-eslint/no-var-requires */
  const { createFakeAgentRuntimeDb } = jest.requireActual("../helpers/fake_agent_runtime_db");
  /* eslint-enable @typescript-eslint/no-var-requires */
  const fake = createFakeAgentRuntimeDb();
  (globalThis as any).__urosRuntimeFakeDb = fake;
  return { db: fake.db, pool: { query: fake.db.query } };
});

jest.mock("../../src/utils/logger", () => ({
  logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

/** Read lazily: the fake only exists once something has required database/client. */
function runtime(): FakeAgentRuntimeDb {
  return (globalThis as any).__urosRuntimeFakeDb as FakeAgentRuntimeDb;
}

interface AuditRow {
  entity_type: string;
  entity_id: string;
  agent_or_user: string;
  action: string;
  input_value: any;
  output_value: any;
  reason_code: string | null;
  reason_comment: string | null;
}

function parseJson(value: unknown): any {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function auditRows(): AuditRow[] {
  return runtime().state.audit_log.map((row) => ({
    entity_type: row.params[2],
    entity_id: row.params[3],
    agent_or_user: row.params[4],
    action: row.params[5],
    input_value: parseJson(row.params[7]),
    output_value: parseJson(row.params[8]),
    reason_code: row.params[9],
    reason_comment: row.params[10],
  }));
}

function actions(): string[] {
  return auditRows().map((r) => r.action);
}

function logMessages(level: "info" | "warn" | "error"): string[] {
  return (logger[level] as unknown as jest.Mock).mock.calls.map((call) => String(call[0]));
}

function logMeta(level: "info" | "warn" | "error", message: string): Record<string, unknown> | undefined {
  const call = (logger[level] as unknown as jest.Mock).mock.calls.find((c) => c[0] === message);
  return call ? (call[1] as Record<string, unknown>) : undefined;
}

const ITEMS = ["A", "B", "C", "D", "E"];

interface CrashHarness {
  processItem: (item: string, index: number) => Promise<string>;
  crash: Promise<never>;
}

/**
 * `processItem` that records what it handled and, on `crashOn`, stops
 * returning and rejects `crash` — the coroutine is abandoned, not unwound.
 */
function crashingProcessItem(handled: string[], crashOn: string): CrashHarness {
  let rejectCrash: ((err: Error) => void) | undefined;
  const crash = new Promise<never>((_resolve, reject) => {
    rejectCrash = reject;
  });
  const processItem = async (item: string): Promise<string> => {
    if (item === crashOn) {
      rejectCrash!(new Error("SIGKILL"));
      // The process is gone: this promise is never settled.
      return new Promise<string>(() => undefined);
    }
    handled.push(item);
    return `done:${item}`;
  };
  return { processItem, crash };
}

beforeEach(() => {
  resetSupervisorForTests();
  runtime().state.agent_batch_progress.length = 0;
  runtime().state.agent_batch_progress_items.length = 0;
  runtime().state.audit_log.length = 0;
  runtime().setTableAvailable(true);
});

afterEach(() => {
  // `supervise(..., exitOnExhaustion: true)` sets a non-zero exit code on
  // purpose. Never let that leak into the test runner's own exit status.
  process.exitCode = 0;
  resetPools();
});

describe("crash mid-batch: resume from persisted state", () => {
  it("leaves RUNNING progress behind, and the next run processes only the remainder", async () => {
    const batchKey = "RESTART:crash-resume";
    const firstRun: string[] = [];
    const { processItem, crash } = crashingProcessItem(firstRun, "D");

    await expect(
      Promise.race([
        runResumableBatch<string>({
          batchKey,
          agentName: "test.resumable",
          items: ITEMS,
          itemKey: (item) => item,
          
          actor: "operator-1",
          request_id: "req-crash-1",
          processItem,
        }),
        crash,
      ])
    ).rejects.toThrow("SIGKILL");

    // Only the items before the crash were handled — and each was persisted.
    expect(firstRun).toEqual(["A", "B", "C"]);
    const crashed = await loadBatchProgress(batchKey);
    expect(crashed).toMatchObject({
      status: "RUNNING",
      agent_name: "test.resumable",
      total_items: 5,
      attempts: 1,
      completed_at: null,
    });
    // Per-item progress is now in agent_batch_progress_item (migration 0031)
    const crashedItems = runtime().state.agent_batch_progress_items.filter(r => r.batch_key === batchKey);
    expect(crashedItems.map(r => r.item_key).sort()).toEqual(["A", "B", "C"]);

    // The abandoned run still owns the key. That is what lets a SIGTERM
    // handler interrupt it immediately instead of waiting out the heartbeat.
    expect(listActiveBatchKeys()).toContain(batchKey);
    expect(await interruptActiveBatches("Process received SIGTERM")).toBe(1);
    expect((await loadBatchProgress(batchKey))!.status).toBe("INTERRUPTED");
    // A second signal changes nothing, and says so rather than over-counting.
    expect(await interruptActiveBatches("Process received SIGINT")).toBe(0);

    // --- the container restarts; the same batch key is re-driven ---
    const secondRun: string[] = [];
    const out = await runResumableBatch<string>({
      batchKey,
      agentName: "test.resumable",
      items: ITEMS,
      itemKey: (item) => item,
      
      actor: "operator-1",
      request_id: "req-crash-2",
      processItem: async (item, index) => {
        secondRun.push(item);
        return `done:${item}@${index}`;
      },
    });

    // No item is handled twice: side effects already committed are not repeated.
    expect(secondRun).toEqual(["D", "E"]);
    expect(out.results).toEqual([
      { key: "D", index: 3, result: "done:D@3" },
      { key: "E", index: 4, result: "done:E@4" },
    ]);
    expect(out).toMatchObject({
      status: "COMPLETED",
      attempts: 2,
      resumed_skipped: 3,
      ok: 2,
      failed: 0,
      already_completed: false,
      checkpointing_available: true,
    });

    // The persisted row now describes the whole batch across both attempts.
    const finished = await loadBatchProgress(batchKey);
    expect(finished).toMatchObject({
      status: "COMPLETED",
      total_items: 5,
      resumed_count: 3,
      attempts: 2,
      last_error: null,
    });
    expect(finished!.completed_at).not.toBeNull();
    expect(listActiveBatchKeys()).not.toContain(batchKey);

    // The resume is audited and reported to the human, not silently absorbed.
    const resumed = auditRows().filter((r) => r.action === "AGENT_BATCH_RESUMED");
    expect(resumed).toHaveLength(1);
    expect(resumed[0]).toMatchObject({ entity_type: "AGENT_BATCH", entity_id: batchKey, reason_code: "AGENT_BATCH_RESUMED" });
    expect(resumed[0].output_value).toEqual({ already_processed: 3, remaining: 2 });
    expect(resumed[0].reason_comment).toMatch(/3 item\(s\) already processed were skipped, 2 remained/);
    expect(actions()).toContain("AGENT_BATCH_COMPLETED");
    expect(logMessages("info")).toContain("AGENT_BATCH_RESUMED");
    expect(metricValue("uros_agent_batch_items_total", { agent: "test.resumable", status: "resumed_skipped" })).toBe(3);
  });

  it("treats a failed item as processed, so a restart neither retries nor forgets it", async () => {
    const batchKey = "RESTART:failed-item-carried";
    const firstRun: string[] = [];
    const { processItem: crashingItem, crash } = crashingProcessItem(firstRun, "D");

    await expect(
      Promise.race([
        runResumableBatch<string>({
          batchKey,
          agentName: "test.failed-carried",
          items: ITEMS,
          itemKey: (item) => item,
          
          processItem: async (item, index) => {
            if (item === "B") throw new Error("malformed candidate row");
            return crashingItem(item, index);
          },
        }),
        crash,
      ])
    ).rejects.toThrow("SIGKILL");

    expect(firstRun).toEqual(["A", "C"]);
    expect((await loadBatchProgress(batchKey))!.status).toBe("RUNNING");
    // Per-item progress is now in agent_batch_progress_item (migration 0031)
    const midItems = runtime().state.agent_batch_progress_items.filter(r => r.batch_key === batchKey);
    expect(midItems.map(r => r.item_key).sort()).toEqual(["A", "B", "C"]);
    expect(midItems.find(r => r.item_key === "B")?.status).toBe("FAILED");
    expect(midItems.find(r => r.item_key === "B")?.error).toBe("malformed candidate row");

    const secondRun: string[] = [];
    const out = await runResumableBatch<string>({
      batchKey,
      agentName: "test.failed-carried",
      items: ITEMS,
      itemKey: (item) => item,
      
      processItem: async (item) => {
        secondRun.push(item);
        return `done:${item}`;
      },
    });

    // B is not re-attempted: it was already handled, flagged and reported.
    expect(secondRun).toEqual(["D", "E"]);
    // But it is not forgotten either — the final summary still carries it.
    expect(out.failures).toEqual([{ key: "B", error: "malformed candidate row" }]);
    expect(out).toMatchObject({ ok: 2, failed: 1, resumed_skipped: 3, status: "COMPLETED" });

    const finished = await loadBatchProgress(batchKey);
    expect(finished!.status).toBe("COMPLETED");
    // Per-item progress is now in agent_batch_progress_item (migration 0031)
    const finishedItems = runtime().state.agent_batch_progress_items.filter(r => r.batch_key === batchKey);
    expect(finishedItems.map(r => r.item_key).sort()).toEqual(["A", "B", "C", "D", "E"]);
    expect(finishedItems.filter(r => r.status === "PROCESSED").length).toBe(4);
    expect(finishedItems.filter(r => r.status === "FAILED").length).toBe(1);
  });

  it("re-running a COMPLETED key starts clean by default, and is a no-op when asked", async () => {
    const batchKey = "RESTART:completed-key";
    const handled: string[] = [];
    const run = () =>
      runResumableBatch<string>({
        batchKey,
        agentName: "test.completed-key",
        items: ["A", "B"],
        itemKey: (item) => item,
        processItem: async (item) => {
          handled.push(item);
          return `done:${item}`;
        },
      });

    await run();
    expect(handled).toEqual(["A", "B"]);
    expect((await loadBatchProgress(batchKey))!.status).toBe("COMPLETED");

    // An operator re-invoking a finished batch expects it to actually re-run.
    const rerun = await run();
    expect(rerun).toMatchObject({ already_completed: false, attempts: 2, resumed_skipped: 0, ok: 2 });
    expect(handled).toEqual(["A", "B", "A", "B"]);

    // ...unless it explicitly asks for no-op semantics.
    const noop = await runResumableBatch<string>({
      batchKey,
      agentName: "test.completed-key",
      items: ["A", "B"],
      itemKey: (item) => item,
      rerunCompleted: false,
      processItem: async (item) => {
        handled.push(item);
        return `done:${item}`;
      },
    });
    expect(noop).toMatchObject({ already_completed: true, status: "COMPLETED", ok: 2, results: [] });
    expect(handled).toEqual(["A", "B", "A", "B"]);
    expect(logMessages("info")).toContain("AGENT_BATCH_ALREADY_COMPLETED");
  });
});

describe("startup recovery of orphaned batches", () => {
  async function startAbandonedBatch(batchKey: string): Promise<void> {
    const { processItem, crash } = crashingProcessItem([], "A");
    await expect(
      Promise.race([
        runResumableBatch<string>({
          batchKey,
          agentName: "test.orphan",
          items: ["A", "B"],
          itemKey: (item) => item,
          
          processItem,
        }),
        crash,
      ])
    ).rejects.toThrow("SIGKILL");
  }

  it("reclaims only batches whose heartbeat has actually gone stale", async () => {
    await startAbandonedBatch("RESTART:orphan-stale");

    // Heartbeat is current: a live owner must not be stolen from.
    expect(await recoverInterruptedBatches()).toBe(0);
    expect((await loadBatchProgress("RESTART:orphan-stale"))!.status).toBe("RUNNING");

    // Five minutes pass for that owner, and a second batch starts right now.
    runtime().advance(300_000);
    await startAbandonedBatch("RESTART:orphan-fresh");

    // Only the stale one is reclaimed; the fresh one is left running.
    expect(await recoverInterruptedBatches()).toBe(1);
    const reclaimed = await loadBatchProgress("RESTART:orphan-stale");
    expect(reclaimed!.status).toBe("INTERRUPTED");
    expect(reclaimed!.last_error).toMatch(/Reclaimed by supervisor: lease expired/);
    expect((await loadBatchProgress("RESTART:orphan-fresh"))!.status).toBe("RUNNING");
    expect(logMessages("warn")).toContain("AGENT_BATCHES_RECLAIMED");

    // A reclaimed batch is resumable, which is the entire point of reclaiming it.
    const handled: string[] = [];
    const out = await runResumableBatch<string>({
      batchKey: "RESTART:orphan-stale",
      agentName: "test.orphan",
      items: ["A", "B"],
      itemKey: (item) => item,
      
      processItem: async (item) => {
        handled.push(item);
        return `done:${item}`;
      },
    });
    expect(handled).toEqual(["A", "B"]);
    expect(out).toMatchObject({ status: "COMPLETED", attempts: 2, resumed_skipped: 0 });
  });

  it("markBatchInterrupted reports false when there is nothing running to interrupt", async () => {
    expect(await markBatchInterrupted("RESTART:never-existed", "no such batch")).toBe(false);
    expect(runtime().state.agent_batch_progress).toHaveLength(0);
  });
});

describe("progress table unavailable (migration 0028 not applied)", () => {
  it("still runs the batch, still isolates failures, and says so loudly", async () => {
    runtime().setTableAvailable(false);
    const handled: string[] = [];

    const out = await runResumableBatch<string>({
      batchKey: "RESTART:no-table",
      agentName: "test.no-table",
      items: ["A", "B", "C"],
      itemKey: (item) => item,
      processItem: async (item) => {
        handled.push(item);
        if (item === "B") throw new Error("item blew up");
        return `done:${item}`;
      },
    });

    expect(handled).toEqual(["A", "B", "C"]);
    expect(out.results.map((r) => r.key)).toEqual(["A", "C"]);
    expect(out.failures).toEqual([{ key: "B", error: "item blew up" }]);
    // Resume capability is degraded, not the batch itself — and it is reported,
    // never silently assumed.
    expect(out.checkpointing_available).toBe(false);
    expect(logMessages("error")).toContain("AGENT_BATCH_CHECKPOINT_UNAVAILABLE");
    expect(logMeta("error", "AGENT_BATCH_CHECKPOINT_UNAVAILABLE")!.hint).toMatch(/npm run migrate/);
    expect(await loadBatchProgress("RESTART:no-table")).toBeNull();
    expect(await recoverInterruptedBatches()).toBe(0);
  });
});

describe("in-app supervisor", () => {
  it("restarts a crashing loop with bounded backoff, auditing every restart", async () => {
    const task = "test.supervised.crash-loop";
    const sleepSpy = jest.fn(async (_ms: number): Promise<void> => undefined);
    const attempts: number[] = [];

    const supervised = supervise({
      name: task,
      maxRestarts: 2,
      restartBackoffMs: 10,
      exitOnExhaustion: false,
      sleep: sleepSpy,
      run: async (attempt) => {
        attempts.push(attempt);
        throw new Error(`poll worker died (attempt ${attempt})`);
      },
    });

    await supervised.start();

    expect(attempts).toEqual([1, 2, 3]);
    expect(supervised.stats()).toMatchObject({ name: task, attempts: 3, restarts: 2, running: false });
    expect(supervised.stats().last_error).toMatch(/poll worker died \(attempt 3\)/);
    // Exponential, capped: 10ms then 20ms.
    expect(sleepSpy.mock.calls.map((c) => c[0])).toEqual([10, 20]);
    expect(metricValue("uros_supervisor_restarts_total", { task })).toBe(2);

    const supervisorActions = auditRows().filter((r) => r.entity_type === "SUPERVISOR");
    expect(supervisorActions.map((r) => r.action)).toEqual([
      "SUPERVISED_TASK_RESTARTED",
      "SUPERVISED_TASK_RESTARTED",
      "SUPERVISED_TASK_GAVE_UP",
    ]);
    expect(supervisorActions[2].reason_code).toBe("SUPERVISOR_RESTARTS_EXHAUSTED");
    expect(supervisorActions[2].reason_comment).toMatch(/failed 3 time\(s\) and the restart budget \(2\) is exhausted/);
    expect(logMessages("error")).toContain("SUPERVISED_TASK_GAVE_UP");
    // It gave up without exiting, so the test process is untouched.
    expect(process.exitCode ?? 0).toBe(0);
  });

  it("stops supervising once the task completes, and records no give-up", async () => {
    const task = "test.supervised.recovers";
    const sleepSpy = jest.fn(async (_ms: number): Promise<void> => undefined);
    let calls = 0;

    const supervised = supervise({
      name: task,
      maxRestarts: 5,
      restartBackoffMs: 1,
      exitOnExhaustion: false,
      sleep: sleepSpy,
      run: async () => {
        calls += 1;
        if (calls === 1) throw new Error("transient boot failure");
      },
    });

    await supervised.start();

    expect(calls).toBe(2);
    expect(supervised.stats()).toMatchObject({ attempts: 2, restarts: 1, running: false, last_error: null });
    expect(supervised.stats().finished_at).not.toBeNull();
    expect(auditRows().filter((r) => r.entity_type === "SUPERVISOR").map((r) => r.action)).toEqual(["SUPERVISED_TASK_RESTARTED"]);
    expect(logMessages("info")).toContain("SUPERVISED_TASK_COMPLETED");
  });

  it("a crash loop that exhausts its budget exits non-zero so the container policy takes over", async () => {
    const task = "test.supervised.exits";
    const supervised = supervise({
      name: task,
      maxRestarts: 0,
      restartBackoffMs: 1,
      exitOnExhaustion: true,
      sleep: async () => undefined,
      run: async () => {
        throw new Error("unrecoverable");
      },
    });

    await expect(supervised.start()).rejects.toThrow("unrecoverable");
    expect(process.exitCode).toBe(1);
    expect(auditRows().filter((r) => r.action === "SUPERVISED_TASK_GAVE_UP")).toHaveLength(1);
  });

  it("stop() prevents a further restart", async () => {
    const task = "test.supervised.stopped";
    let calls = 0;
    const supervised = supervise({
      name: task,
      maxRestarts: 5,
      restartBackoffMs: 1,
      exitOnExhaustion: false,
      sleep: async () => undefined,
      run: async () => {
        calls += 1;
        supervised.stop();
        throw new Error("shutting down");
      },
    });

    await supervised.start();

    expect(calls).toBe(1);
    expect(supervised.stats()).toMatchObject({ restarts: 0, stopped: true });
    expect(auditRows().filter((r) => r.entity_type === "SUPERVISOR")).toHaveLength(0);
  });
});

describe("graceful shutdown", () => {
  it("marks this process's in-flight batches INTERRUPTED, drains pools, and is idempotent", async () => {
    const batchKey = "RESTART:graceful-shutdown";
    let releaseGate: (() => void) | undefined;
    let signalItemStarted: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    const itemStarted = new Promise<void>((resolve) => {
      signalItemStarted = resolve;
    });

    const pending = runResumableBatch<string>({
      batchKey,
      agentName: "test.shutdown",
      items: ["A", "B"],
      itemKey: (item) => item,
      
      processItem: async () => {
        signalItemStarted!();
        await gate;
        return "done";
      },
    });
    pending.catch(() => undefined);

    // Wait until the batch has claimed its row and is genuinely mid-item.
    await itemStarted;
    expect((await loadBatchProgress(batchKey))!.status).toBe("RUNNING");

    await gracefulShutdown("SIGTERM", false);

    // The in-flight batch is now resumable by whoever comes next, instead of
    // being left RUNNING until its heartbeat goes stale.
    expect((await loadBatchProgress(batchKey))!.status).toBe("INTERRUPTED");
    expect(actions()).toContain("AGENT_RUNTIME_SHUTDOWN");
    expect(logMessages("warn")).toContain("AGENT_RUNTIME_SHUTTING_DOWN");

    // Several signals in quick succession must not tear the runtime down twice.
    await gracefulShutdown("SIGINT", false);
    expect(actions().filter((a) => a === "AGENT_RUNTIME_SHUTDOWN")).toHaveLength(1);

    releaseGate!();
    await pending;
  });
});
