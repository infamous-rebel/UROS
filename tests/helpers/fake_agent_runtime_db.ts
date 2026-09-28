/**
 * In-memory fake for the `agent_batch_progress` table (migration 0028) and
 * `audit_log`, scoped to exactly the statements
 * `src/services/agent_runner/batch.ts` issues.
 *
 * Two things make this more than a stub:
 *
 *  1. It enforces the migration's CHECK constraints. A checkpoint writer
 *     that leaves `succeeded + failed > processed`, or marks a batch
 *     COMPLETED with items outstanding, fails here exactly as it would in
 *     Postgres — so the resume tests cannot pass on inconsistent state.
 *  2. It has a controllable clock and a kill switch. `ageHeartbeat` lets a
 *     test reproduce "the owning process died 5 minutes ago", and
 *     `setTableAvailable(false)` reproduces "migration 0028 has not been
 *     applied yet", which the batch layer is designed to survive.
 *
 * Dispatch is on a normalized SQL prefix, matching the other fakes in this
 * directory: honest for a fixed, known query set, not a query engine.
 */
export type FakeBatchStatus = "RUNNING" | "INTERRUPTED" | "COMPLETED" | "FAILED";

export interface FakeBatchRow {
  batch_key: string;
  agent_name: string;
  org_id: string | null;
  status: FakeBatchStatus;
  total_items: number;
  processed_count: number;
  succeeded_count: number;
  failed_count: number;
  resumed_count: number;
  attempts: number;
  processed_keys: string[];
  failures: Array<{ key: string; error: string }>;
  last_error: string | null;
  actor: string | null;
  request_id: string | null;
  started_at: string;
  heartbeat_at: string;
  completed_at: string | null;
  updated_at: string;
}

export interface FakeAgentRuntimeDbState {
  agent_batch_progress: FakeBatchRow[];
  audit_log: Array<{ id: number; params: any[] }>;
}

export interface FakeAgentRuntimeDb {
  state: FakeAgentRuntimeDbState;
  db: {
    query: (text: string, params?: any[]) => Promise<{ rows: any[]; rowCount: number }>;
    withTransaction: <T>(fn: (client: { query: (text: string, params?: any[]) => Promise<{ rows: any[]; rowCount: number }> }) => Promise<T>) => Promise<T>;
  };
  /** Current fake clock, in ms since epoch. */
  nowMs: () => number;
  /** Moves the fake clock forward. */
  advance: (ms: number) => void;
  /** Back-dates one row's heartbeat, simulating a process that died `ms` ago. */
  ageHeartbeat: (batchKey: string, ms: number) => void;
  /** Simulates migration 0028 not being applied: every statement on the table fails. */
  setTableAvailable: (available: boolean) => void;
  rowFor: (batchKey: string) => FakeBatchRow | undefined;
}

const TABLE_UNAVAILABLE = 'relation "agent_batch_progress" does not exist';

export function createFakeAgentRuntimeDb(startMs: number = 1_760_000_000_000): FakeAgentRuntimeDb {
  const state: FakeAgentRuntimeDbState = { agent_batch_progress: [], audit_log: [] };

  let clock = startMs;
  let auditSeq = 1;
  let tableAvailable = true;

  const nowIso = (): string => new Date(clock).toISOString();

  function assertConstraints(row: FakeBatchRow): void {
    if (row.succeeded_count + row.failed_count > row.processed_count) {
      throw new Error(
        `CHECK agent_batch_progress_counts_consistent: succeeded(${row.succeeded_count}) + failed(${row.failed_count}) > processed(${row.processed_count})`
      );
    }
    if (row.processed_count > row.total_items) {
      throw new Error(`CHECK agent_batch_progress_counts_consistent: processed(${row.processed_count}) > total(${row.total_items})`);
    }
    if (row.status === "COMPLETED" && row.processed_count !== row.total_items) {
      throw new Error(
        `CHECK agent_batch_progress_completed_is_full: status COMPLETED with processed(${row.processed_count}) != total(${row.total_items})`
      );
    }
    if (new Date(row.heartbeat_at).getTime() < new Date(row.started_at).getTime()) {
      throw new Error("CHECK agent_batch_progress_heartbeat_after_start: heartbeat precedes start");
    }
  }

  function requireTable(): void {
    if (!tableAvailable) throw new Error(TABLE_UNAVAILABLE);
  }

  function parseJsonArray<T>(value: unknown, fallback: T[]): T[] {
    if (Array.isArray(value)) return value as T[];
    if (typeof value !== "string") return fallback;
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? (parsed as T[]) : fallback;
    } catch {
      return fallback;
    }
  }

  function clone(row: FakeBatchRow): FakeBatchRow {
    return { ...row, processed_keys: [...row.processed_keys], failures: row.failures.map((f) => ({ ...f })) };
  }

  async function query(text: string, params: any[] = []): Promise<{ rows: any[]; rowCount: number }> {
    const sql = text.replace(/\s+/g, " ").trim();

    if (sql.startsWith("INSERT INTO audit_log")) {
      state.audit_log.push({ id: auditSeq++, params });
      return { rows: [], rowCount: 1 };
    }

    if (!sql.includes("agent_batch_progress")) {
      throw new Error(`Fake agent runtime DB: unhandled query: ${sql}`);
    }
    requireTable();

    // --- loadBatchProgress ---
    if (sql.startsWith("SELECT * FROM agent_batch_progress WHERE batch_key=$1")) {
      const row = state.agent_batch_progress.find((r) => r.batch_key === params[0]);
      return { rows: row ? [clone(row)] : [], rowCount: row ? 1 : 0 };
    }

    // --- beginBatch: INSERT ... ON CONFLICT (batch_key) DO UPDATE ... RETURNING * ---
    if (sql.startsWith("INSERT INTO agent_batch_progress")) {
      const [batchKey, agentName, orgId, totalItems, processedCount, succeededCount, failedCount, resumedCount, processedKeysJson, failuresJson, actor, requestId] = params;
      const existing = state.agent_batch_progress.find((r) => r.batch_key === batchKey);
      const row: FakeBatchRow = existing
        ? {
            ...existing,
            agent_name: agentName,
            org_id: orgId ?? existing.org_id,
            status: "RUNNING",
            total_items: Number(totalItems),
            processed_count: Number(processedCount),
            succeeded_count: Number(succeededCount),
            failed_count: Number(failedCount),
            resumed_count: Number(resumedCount),
            attempts: existing.attempts + 1,
            processed_keys: parseJsonArray<string>(processedKeysJson, []),
            failures: parseJsonArray(failuresJson, []),
            last_error: null,
            actor,
            request_id: requestId ?? null,
            heartbeat_at: nowIso(),
            completed_at: null,
            updated_at: nowIso(),
          }
        : {
            batch_key: batchKey,
            agent_name: agentName,
            org_id: orgId ?? null,
            status: "RUNNING",
            total_items: Number(totalItems),
            processed_count: Number(processedCount),
            succeeded_count: Number(succeededCount),
            failed_count: Number(failedCount),
            resumed_count: Number(resumedCount),
            attempts: 1,
            processed_keys: parseJsonArray<string>(processedKeysJson, []),
            failures: parseJsonArray(failuresJson, []),
            last_error: null,
            actor,
            request_id: requestId ?? null,
            started_at: nowIso(),
            heartbeat_at: nowIso(),
            completed_at: null,
            updated_at: nowIso(),
          };
      assertConstraints(row);
      if (existing) Object.assign(existing, row);
      else state.agent_batch_progress.push(row);
      return { rows: [clone(row)], rowCount: 1 };
    }

    // --- persistCheckpoint ---
    if (sql.startsWith("UPDATE agent_batch_progress SET processed_keys=$2::jsonb")) {
      const [batchKey, processedKeysJson, failuresJson, processedCount, succeededCount, failedCount, resumedCount, lastError] = params;
      const row = state.agent_batch_progress.find((r) => r.batch_key === batchKey);
      if (!row) return { rows: [], rowCount: 0 };
      row.processed_keys = parseJsonArray<string>(processedKeysJson, []);
      row.failures = parseJsonArray(failuresJson, []);
      row.processed_count = Number(processedCount);
      row.succeeded_count = Number(succeededCount);
      row.failed_count = Number(failedCount);
      row.resumed_count = Number(resumedCount);
      row.last_error = lastError ?? null;
      row.heartbeat_at = nowIso();
      row.updated_at = nowIso();
      assertConstraints(row);
      return { rows: [], rowCount: 1 };
    }

    // --- finishBatch ---
    if (sql.startsWith("UPDATE agent_batch_progress SET status=$2,")) {
      const [batchKey, status, processedKeysJson, failuresJson, processedCount, succeededCount, failedCount, resumedCount, totalItems, lastError] = params;
      const row = state.agent_batch_progress.find((r) => r.batch_key === batchKey);
      if (!row) return { rows: [], rowCount: 0 };
      row.status = status as FakeBatchStatus;
      row.processed_keys = parseJsonArray<string>(processedKeysJson, []);
      row.failures = parseJsonArray(failuresJson, []);
      row.processed_count = Number(processedCount);
      row.succeeded_count = Number(succeededCount);
      row.failed_count = Number(failedCount);
      row.resumed_count = Number(resumedCount);
      row.total_items = Number(totalItems);
      row.last_error = lastError ?? null;
      if (status === "COMPLETED" || status === "FAILED") row.completed_at = nowIso();
      row.heartbeat_at = nowIso();
      row.updated_at = nowIso();
      assertConstraints(row);
      return { rows: [], rowCount: 1 };
    }

    // --- markBatchInterrupted ---
    if (sql.startsWith("UPDATE agent_batch_progress SET status='INTERRUPTED', last_error=$2, heartbeat_at=now()")) {
      const [batchKey, reason] = params;
      const row = state.agent_batch_progress.find((r) => r.batch_key === batchKey && r.status === "RUNNING");
      if (!row) return { rows: [], rowCount: 0 };
      row.status = "INTERRUPTED";
      row.last_error = reason;
      row.heartbeat_at = nowIso();
      row.updated_at = nowIso();
      assertConstraints(row);
      return { rows: [], rowCount: 1 };
    }

    // --- recoverInterruptedBatches: reclaim RUNNING rows with a stale heartbeat ---
    if (sql.startsWith("UPDATE agent_batch_progress SET status='INTERRUPTED', last_error=COALESCE(")) {
      const staleAfterMs = Number(params[0]);
      const cutoff = clock - staleAfterMs;
      const reclaimed = state.agent_batch_progress.filter(
        (r) => r.status === "RUNNING" && new Date(r.heartbeat_at).getTime() < cutoff
      );
      for (const row of reclaimed) {
        row.status = "INTERRUPTED";
        row.last_error = row.last_error ?? `Reclaimed by supervisor: heartbeat older than ${staleAfterMs}ms`;
        row.updated_at = nowIso();
        assertConstraints(row);
      }
      return { rows: reclaimed.map((r) => ({ batch_key: r.batch_key, agent_name: r.agent_name })), rowCount: reclaimed.length };
    }

    throw new Error(`Fake agent runtime DB: unhandled query: ${sql}`);
  }

  const client = { query };

  return {
    state,
    db: { query, withTransaction: async <T>(fn: (c: typeof client) => Promise<T>): Promise<T> => fn(client) },
    nowMs: () => clock,
    advance: (ms: number) => {
      clock += ms;
    },
    ageHeartbeat: (batchKey: string, ms: number) => {
      const row = state.agent_batch_progress.find((r) => r.batch_key === batchKey);
      if (!row) throw new Error(`Fake agent runtime DB: no batch row for key '${batchKey}'`);
      row.heartbeat_at = new Date(new Date(row.heartbeat_at).getTime() - ms).toISOString();
    },
    setTableAvailable: (available: boolean) => {
      tableAvailable = available;
    },
    rowFor: (batchKey: string) => state.agent_batch_progress.find((r) => r.batch_key === batchKey),
  };
}
