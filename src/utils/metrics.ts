/**
 * Minimal in-process Prometheus text-format metrics registry.
 *
 * Deliberately dependency-free (no `prom-client`): UROS's principle of
 * "no black box" extends to its own operational tooling — a few dozen
 * lines of plain counters/gauges/histograms are easier to audit than a
 * third-party client library, and this environment cannot reliably run
 * `npm install` for new dependencies mid-build. Swap for `prom-client`
 * later if richer exposition (summaries, quantiles) is ever needed;
 * the call sites (`metrics.httpRequestsTotal.inc(...)`) would not change.
 *
 * Single-process scope: like the in-memory rate limiter (see
 * `rate_limit.ts`), these counters reset on restart and are not shared
 * across horizontally-scaled instances. Prometheus's own `sum()` /
 * `rate()` aggregation across scraped instances is the intended way to
 * get a fleet-wide view — this module does not need to solve that.
 */

type Labels = Record<string, string>;

function labelKey(labels: Labels): string {
  const keys = Object.keys(labels).sort();
  if (keys.length === 0) return "";
  return keys.map((k) => `${k}="${escapeLabelValue(labels[k])}"`).join(",");
}

function escapeLabelValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

class Counter {
  private values = new Map<string, number>();
  constructor(private readonly name: string, private readonly help: string) {}

  inc(labels: Labels = {}, value = 1): void {
    const key = labelKey(labels);
    this.values.set(key, (this.values.get(key) ?? 0) + value);
  }

  toPrometheus(): string {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} counter`];
    for (const [key, value] of this.values.entries()) {
      lines.push(`${this.name}${key ? `{${key}}` : ""} ${value}`);
    }
    return lines.join("\n");
  }
}

class Gauge {
  private values = new Map<string, number>();
  constructor(private readonly name: string, private readonly help: string) {}

  set(labels: Labels, value: number): void {
    this.values.set(labelKey(labels), value);
  }

  toPrometheus(): string {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} gauge`];
    for (const [key, value] of this.values.entries()) {
      lines.push(`${this.name}${key ? `{${key}}` : ""} ${value}`);
    }
    return lines.join("\n");
  }
}

const DEFAULT_DURATION_BUCKETS_MS = [10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000];

class Histogram {
  private bucketCounts = new Map<string, number[]>();
  private sums = new Map<string, number>();
  private totalCounts = new Map<string, number>();

  constructor(
    private readonly name: string,
    private readonly help: string,
    private readonly buckets: number[] = DEFAULT_DURATION_BUCKETS_MS
  ) {}

  observe(labels: Labels, value: number): void {
    const key = labelKey(labels);
    if (!this.bucketCounts.has(key)) {
      this.bucketCounts.set(key, new Array(this.buckets.length).fill(0));
    }
    const arr = this.bucketCounts.get(key)!;
    for (let i = 0; i < this.buckets.length; i++) {
      if (value <= this.buckets[i]) arr[i] += 1;
    }
    this.sums.set(key, (this.sums.get(key) ?? 0) + value);
    this.totalCounts.set(key, (this.totalCounts.get(key) ?? 0) + 1);
  }

  toPrometheus(): string {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} histogram`];
    for (const [key, arr] of this.bucketCounts.entries()) {
      const prefix = key ? `${key},` : "";
      for (let i = 0; i < this.buckets.length; i++) {
        lines.push(`${this.name}_bucket{${prefix}le="${this.buckets[i]}"} ${arr[i]}`);
      }
      lines.push(`${this.name}_bucket{${prefix}le="+Inf"} ${this.totalCounts.get(key)}`);
      lines.push(`${this.name}_sum${key ? `{${key}}` : ""} ${this.sums.get(key)}`);
      lines.push(`${this.name}_count${key ? `{${key}}` : ""} ${this.totalCounts.get(key)}`);
    }
    return lines.join("\n");
  }
}

export const metrics = {
  httpRequestsTotal: new Counter("uros_http_requests_total", "Total HTTP requests by method, route, and status"),
  httpRequestDurationMs: new Histogram("uros_http_request_duration_ms", "HTTP request duration in milliseconds"),
  evaluationJobsTotal: new Counter("uros_evaluation_jobs_total", "Evaluation jobs by outcome status"),
  auditLogWritesTotal: new Counter("uros_audit_log_writes_total", "Immutable audit log writes by entity type and action"),
  webhookDeliveriesTotal: new Counter("uros_webhook_deliveries_total", "Outgoing webhook delivery attempts by status"),
  processUptimeSeconds: new Gauge("uros_process_uptime_seconds", "Process uptime in seconds"),
  healthCheckStatus: new Gauge("uros_health_check_status", "1 = ok, 0 = down, 0.5 = not_configured, per component"),

  // --- Agent-Level Hardening: per-agent resilience telemetry ---
  // Incremented exclusively from src/services/agent_runner, so any agent
  // registered with the runner is instrumented automatically — no
  // per-agent wiring, and no way for a new agent to forget its metrics.
  agentInvocationsTotal: new Counter(
    "uros_agent_invocations_total",
    "Agent invocations by agent, class and terminal outcome (success|failure|timeout|circuit_open)"
  ),
  agentSuccessesTotal: new Counter("uros_agent_successes_total", "Agent invocations that completed within timeout"),
  agentFailuresTotal: new Counter("uros_agent_failures_total", "Agent invocations that exhausted retries or failed permanently"),
  agentRetriesTotal: new Counter("uros_agent_retries_total", "Transient-failure retries performed by the agent runner"),
  agentTimeoutsTotal: new Counter("uros_agent_timeouts_total", "Agent invocations that exceeded AGENT_TIMEOUT_MS"),
  agentCircuitOpenTotal: new Counter(
    "uros_agent_circuit_open_total",
    "Number of times an agent circuit breaker transitioned to OPEN (circuit_open_count)"
  ),
  agentCircuitState: new Gauge("uros_agent_circuit_state", "Current circuit state per agent: 0=CLOSED, 1=HALF_OPEN, 2=OPEN"),
  agentDurationMs: new Histogram("uros_agent_duration_ms", "Agent invocation duration in milliseconds (all attempts)"),
  agentQueueDepth: new Gauge("uros_agent_queue_depth", "Tasks waiting for a worker, per agent-class pool"),
  agentQueueActive: new Gauge("uros_agent_queue_active", "Tasks currently executing, per agent-class pool"),
  agentPoolRejectedTotal: new Counter("uros_agent_pool_rejected_total", "Submissions rejected because a pool queue was saturated"),
  agentBatchItemsTotal: new Counter(
    "uros_agent_batch_items_total",
    "Per-item outcomes inside resumable/isolated batches (ok|failed|resumed_skipped)"
  ),
  supervisorRestartsTotal: new Counter("uros_supervisor_restarts_total", "Restarts performed by the in-app supervisor, per task"),
};

/** Circuit state -> numeric gauge value (stable mapping, documented in the metric HELP). */
export function circuitStateToGaugeValue(state: "CLOSED" | "HALF_OPEN" | "OPEN"): number {
  if (state === "CLOSED") return 0;
  if (state === "HALF_OPEN") return 1;
  return 2;
}

/** Renders every registered metric in Prometheus text exposition format. */
export function renderMetrics(): string {
  metrics.processUptimeSeconds.set({}, Math.round(process.uptime()));
  return (
    [
      metrics.httpRequestsTotal.toPrometheus(),
      metrics.httpRequestDurationMs.toPrometheus(),
      metrics.evaluationJobsTotal.toPrometheus(),
      metrics.auditLogWritesTotal.toPrometheus(),
      metrics.webhookDeliveriesTotal.toPrometheus(),
      metrics.processUptimeSeconds.toPrometheus(),
      metrics.healthCheckStatus.toPrometheus(),
      metrics.agentInvocationsTotal.toPrometheus(),
      metrics.agentSuccessesTotal.toPrometheus(),
      metrics.agentFailuresTotal.toPrometheus(),
      metrics.agentRetriesTotal.toPrometheus(),
      metrics.agentTimeoutsTotal.toPrometheus(),
      metrics.agentCircuitOpenTotal.toPrometheus(),
      metrics.agentCircuitState.toPrometheus(),
      metrics.agentDurationMs.toPrometheus(),
      metrics.agentQueueDepth.toPrometheus(),
      metrics.agentQueueActive.toPrometheus(),
      metrics.agentPoolRejectedTotal.toPrometheus(),
      metrics.agentBatchItemsTotal.toPrometheus(),
      metrics.supervisorRestartsTotal.toPrometheus(),
    ].join("\n\n") + "\n"
  );
}
