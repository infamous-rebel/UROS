/**
 * Unit tests for the bounded-concurrency worker pool that keeps slow agent
 * work off the API request path.
 *
 * Every test here is driven by explicit deferreds rather than sleeps, so
 * the ordering and concurrency assertions are deterministic.
 */
import { WorkerPool } from "../../../src/services/agent_runner/worker_pool";
import { PoolSaturatedError, isTransientError } from "../../../src/services/agent_runner/types";
import { metricValue } from "../../helpers/metrics_probe";

jest.mock("../../../src/utils/logger", () => ({
  logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

function deferred<T = void>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Yields until queued microtasks and one macrotask have run (enough for `pump`). */
function tick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function makePool(size = 2, maxQueueDepth = 100): WorkerPool {
  return new WorkerPool({ name: `test-pool-${size}-${maxQueueDepth}`, size, maxQueueDepth });
}

describe("WorkerPool: concurrency and ordering", () => {
  it("never runs more than `size` tasks at once and starts them FIFO", async () => {
    const pool = makePool(2);
    const gate = deferred();
    const started: number[] = [];
    let active = 0;
    let peak = 0;

    const tasks = Array.from({ length: 5 }, (_, i) =>
      pool.submit(async () => {
        started.push(i);
        active += 1;
        peak = Math.max(peak, active);
        await gate.promise;
        active -= 1;
        return i * 10;
      })
    );

    await tick();
    expect(started).toEqual([0, 1]);
    expect(pool.active).toBe(2);
    expect(pool.depth).toBe(3);

    gate.resolve();
    await expect(Promise.all(tasks)).resolves.toEqual([0, 10, 20, 30, 40]);

    expect(peak).toBe(2);
    expect(started).toEqual([0, 1, 2, 3, 4]);
    expect(pool.snapshot()).toMatchObject({ size: 2, active: 0, queued: 0, completed: 5, failed: 0, rejected: 0, stopped: false });
  });

  it("delivers each task's own result or error to its own submitter", async () => {
    const pool = makePool(3);

    const ok = pool.submit(async () => "fine");
    const boom = pool.submit(async (): Promise<string> => {
      throw new Error("task exploded");
    });

    await expect(ok).resolves.toBe("fine");
    await expect(boom).rejects.toThrow("task exploded");
    expect(pool.snapshot()).toMatchObject({ completed: 1, failed: 1 });
  });

  it("runs a size-1 pool strictly sequentially", async () => {
    const pool = makePool(1);
    const order: string[] = [];

    await Promise.all([
      pool.submit(async () => {
        await tick();
        order.push("a");
      }),
      pool.submit(async () => {
        order.push("b");
      }),
    ]);

    expect(order).toEqual(["a", "b"]);
  });

  it("publishes queue depth and active-worker gauges per pool", async () => {
    const pool = new WorkerPool({ name: "gauged", size: 1, maxQueueDepth: 10, metricLabel: "scoring" });
    const gate = deferred();
    const first = pool.submit(() => gate.promise.then(() => "a"));
    pool.submit(async () => "b").catch(() => undefined);

    await tick();
    expect(metricValue("uros_agent_queue_active", { pool: "scoring" })).toBe(1);
    expect(metricValue("uros_agent_queue_depth", { pool: "scoring" })).toBe(1);

    gate.resolve();
    await first;
    await pool.drain();
    expect(metricValue("uros_agent_queue_depth", { pool: "scoring" })).toBe(0);
  });
});

describe("WorkerPool: backpressure", () => {
  it("rejects submissions past maxQueueDepth instead of growing without bound", async () => {
    const pool = makePool(1, 2);
    const gate = deferred();

    const running = pool.submit(() => gate.promise.then(() => "running"));
    const q1 = pool.submit(async () => "q1");
    const q2 = pool.submit(async () => "q2");
    await tick();
    expect(pool.depth).toBe(2);

    const err = await pool.submit(async () => "never").catch((e) => e);
    expect(err).toBeInstanceOf(PoolSaturatedError);
    expect((err as PoolSaturatedError).max_queue_depth).toBe(2);
    expect(pool.rejected).toBe(1);
    expect(metricValue("uros_agent_pool_rejected_total", { pool: pool.name })).toBe(1);

    // Saturation is backpressure, not corruption: the accepted work still completes.
    gate.resolve();
    await expect(running).resolves.toBe("running");
    await expect(q1).resolves.toBe("q1");
    await expect(q2).resolves.toBe("q2");
  });

  it("classifies pool saturation as transient so callers get a bounded retry", () => {
    expect(isTransientError(new PoolSaturatedError("p", 1))).toBe(true);
  });
});

describe("WorkerPool: drain and shutdown", () => {
  it("drain() resolves immediately on an idle pool and otherwise waits for in-flight work", async () => {
    const pool = makePool(2);
    await expect(pool.drain()).resolves.toBeUndefined();

    const gate = deferred();
    let finished = false;
    const task = pool.submit(async () => {
      await gate.promise;
      finished = true;
    });

    let drained = false;
    const draining = pool.drain().then(() => {
      drained = true;
    });

    await tick();
    expect(drained).toBe(false);
    gate.resolve();
    await task;
    await draining;
    expect(finished).toBe(true);
    expect(drained).toBe(true);
  });

  it("shutdown() rejects queued-but-unstarted tasks, waits for in-flight work, then refuses new tasks", async () => {
    const pool = makePool(1, 10);
    const gate = deferred();

    const running = pool.submit(() => gate.promise.then(() => "in-flight done"));
    const queued = pool.submit(async () => "queued");
    await tick();

    const shuttingDown = pool.shutdown();
    expect(pool.isStopped).toBe(true);

    await expect(queued).rejects.toThrow(/shut down before this task started/);

    gate.resolve();
    await expect(running).resolves.toBe("in-flight done");
    await shuttingDown;

    expect(pool.snapshot()).toMatchObject({ active: 0, queued: 0, completed: 1, stopped: true });
    await expect(pool.submit(async () => "late")).rejects.toThrow(/shut down and not accepting tasks/);
  });

  it("shutdown() on an idle pool resolves without error", async () => {
    const pool = makePool(2);
    await expect(pool.shutdown()).resolves.toBeUndefined();
    expect(pool.isStopped).toBe(true);
  });
});
