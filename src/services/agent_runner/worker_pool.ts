/**
 * Bounded-concurrency worker pool.
 *
 * Purpose: keep slow, CPU- or I/O-heavy agent work off the request path.
 * The API hands a task to a pool and gets a promise back; at most
 * `size` tasks per pool ever run concurrently, and additional tasks wait
 * in a FIFO queue rather than all hitting Postgres/OCR at once.
 *
 * Deliberately dependency-free (no BullMQ, no worker_threads):
 *  - It is in-process, so it adds zero latency and zero new infrastructure
 *    to the happy path — a queue array and a counter.
 *  - Durable, cross-process queuing is already solved by
 *    `services/queue` (BullMQ when REDIS_URL is set, `FOR UPDATE SKIP
 *    LOCKED` otherwise). This pool sits *inside* a worker/API process and
 *    bounds how much of that process one agent class may consume.
 *  - The task signature is a plain `() => Promise<T>`, so any future
 *    multi-agent stack (LangGraph, Temporal, a message-bus consumer) can
 *    be plugged in by handing its dispatch function to `submit`.
 *
 * Backpressure: when the queue reaches `maxQueueDepth`, `submit` rejects
 * immediately with `PoolSaturatedError` instead of growing memory without
 * bound. That error is classified transient by the runner, so callers get
 * a bounded retry rather than a silent OOM.
 */
import { metrics } from "../../utils/metrics";
import { logger } from "../../utils/logger";
import { PoolSaturatedError } from "./types";

interface QueueItem {
  run: () => Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (err: unknown) => void;
}

export interface WorkerPoolOptions {
  name: string;
  size: number;
  maxQueueDepth: number;
  /** Metric label; defaults to `name`. */
  metricLabel?: string;
}

export interface WorkerPoolSnapshot {
  name: string;
  size: number;
  active: number;
  queued: number;
  completed: number;
  failed: number;
  rejected: number;
  stopped: boolean;
}

export class WorkerPool {
  private readonly queue: QueueItem[] = [];
  private activeCount = 0;
  private completedCount = 0;
  private failedCount = 0;
  private rejectedCount = 0;
  private stopped = false;
  private readonly idleWaiters: Array<() => void> = [];
  private readonly label: string;

  constructor(private readonly options: WorkerPoolOptions) {
    this.label = options.metricLabel ?? options.name;
  }

  get name(): string {
    return this.options.name;
  }

  get size(): number {
    return this.options.size;
  }

  get active(): number {
    return this.activeCount;
  }

  get depth(): number {
    return this.queue.length;
  }

  get rejected(): number {
    return this.rejectedCount;
  }

  get isStopped(): boolean {
    return this.stopped;
  }

  /**
   * Queues `task` and resolves with its result. Never starts more than
   * `size` tasks at once. If the pool is stopped or the queue is full, the
   * returned promise rejects — the task is never silently dropped.
   */
  submit<T>(task: () => Promise<T>): Promise<T> {
    if (this.stopped) {
      return Promise.reject(new Error(`Worker pool '${this.options.name}' is shut down and not accepting tasks`));
    }
    if (this.queue.length >= this.options.maxQueueDepth) {
      this.rejectedCount += 1;
      metrics.agentPoolRejectedTotal.inc({ pool: this.label });
      logger.warn("AGENT_POOL_SATURATED", {
        pool: this.options.name,
        queued: this.queue.length,
        max_queue_depth: this.options.maxQueueDepth,
      });
      return Promise.reject(new PoolSaturatedError(this.options.name, this.options.maxQueueDepth));
    }

    return new Promise<T>((resolve, reject) => {
      this.queue.push({
        run: task as () => Promise<unknown>,
        resolve: resolve as (value: unknown) => void,
        reject,
      });
      this.publish();
      this.pump();
    });
  }

  /** Resolves once the queue is empty and no task is running. Does not stop the pool. */
  drain(): Promise<void> {
    if (this.activeCount === 0 && this.queue.length === 0) return Promise.resolve();
    return new Promise<void>((resolve) => this.idleWaiters.push(resolve));
  }

  /** Refuses new work, waits for in-flight tasks to finish, then resolves. Queued-but-unstarted tasks are rejected. */
  async shutdown(): Promise<void> {
    this.stopped = true;
    while (this.queue.length > 0) {
      const item = this.queue.shift();
      item?.reject(new Error(`Worker pool '${this.options.name}' shut down before this task started`));
    }
    await this.drain();
    this.publish();
    logger.info("AGENT_POOL_SHUTDOWN", { pool: this.options.name, completed: this.completedCount, failed: this.failedCount });
  }

  snapshot(): WorkerPoolSnapshot {
    return {
      name: this.options.name,
      size: this.options.size,
      active: this.activeCount,
      queued: this.queue.length,
      completed: this.completedCount,
      failed: this.failedCount,
      rejected: this.rejectedCount,
      stopped: this.stopped,
    };
  }

  private pump(): void {
    while (this.activeCount < this.options.size && this.queue.length > 0 && !this.stopped) {
      const item = this.queue.shift()!;
      this.activeCount += 1;
      this.publish();
      // Fire-and-forget by construction: completion is delivered through
      // the promise returned to the submitter. The catch here only guards
      // against a task that rejects *after* we already settled it, which
      // would otherwise surface as an unhandled rejection and kill the
      // process under Node's default policy.
      void Promise.resolve()
        .then(() => item.run())
        .then(
          (value) => {
            this.completedCount += 1;
            item.resolve(value);
          },
          (err) => {
            this.failedCount += 1;
            item.reject(err);
          }
        )
        .finally(() => {
          this.activeCount -= 1;
          this.publish();
          if (this.activeCount === 0 && this.queue.length === 0) {
            const waiters = this.idleWaiters.splice(0, this.idleWaiters.length);
            for (const w of waiters) w();
          }
          this.pump();
        });
    }
  }

  private publish(): void {
    metrics.agentQueueDepth.set({ pool: this.label }, this.queue.length);
    metrics.agentQueueActive.set({ pool: this.label }, this.activeCount);
  }
}
