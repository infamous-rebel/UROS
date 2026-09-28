/**
 * In-memory fake for the `agent_batch_progress` + `agent_batch_progress_item`
 * tables (migration 0031) and `audit_log`, scoped to exactly the statements
 * `src/services/agent_runner/batch.ts` issues.
 *
 * Key features:
 *  1. Per-item checkpoint table (agent_batch_progress_item) with PK enforcement.
 *  2. Lease/fencing concurrency protection: persistCheckpoint and finishBatch
 *     carry fencing tokens; mismatch returns rowCount=0.
 *  3. Controllable clock + `ageLease` to simulate lease expiry.
 *  4. `setTableAvailable(false)` simulates migration not applied.
 *
 * Dispatch is on a normalized SQL prefix, matching the other fakes.
 */
export type FakeBatchStatus = "RUNNING" | "INTERRUPTED" | "COMPLETED" | "FAILED";

export interface FakeBatchRow {
  batch_key: string;
  agent_name: string;
  org_id: string | null;
  status: FakeBatchStatus;
  total_items: number;
  resumed_count: number;
  attempts: number;
  owner_id: string | null;
  lease_expires_at: string | null;
  fencing_token: number;
  last_error: string | null;
  actor: string | null;
  request_id: string | null;
  started_at: string;
  heartbeat_at: string;
  completed_at: string | null;
  updated_at: string;
}

export interface FakeBatchItemRow {
  batch_key: string;
  item_key: string;
  status: "PROCESSED" | "FAILED";
  error: string | null;
  processed_at: string;
}

export interface FakeAgentRuntimeDbState {
  agent_batch_progress: FakeBatchRow[];
  agent_batch_progress_items: FakeBatchItemRow[];
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
  /** Back-dates one row's lease_expires_at, simulating a process whose lease expired `ms` ago. */
  ageLease: (batchKey: string, ms: number) => void;
  /** Simulates migration 0031 not being applied: every statement on the table fails. */
  setTableAvailable: (available: boolean) => void;
  rowFor: (batchKey: string) => FakeBatchRow | undefined;
}

const TABLE_UNAVAILABLE = 'relation "agent_batch_progress" does not exist';

export function createFakeAgentRuntimeDb(startMs: number = 1_760_000_000_000): FakeAgentRuntimeDb {
  const state: FakeAgentRuntimeDbState = { agent_batch_progress: [], agent_batch_progress_items: [], audit_log: [] };

  let clock = startMs;
  let auditSeq = 1;
  let tableAvailable = true;

  const nowIso = (): string => new Date(clock).toISOString();

  function requireTable(): void {
    if (!tableAvailable) throw new Error(TABLE_UNAVAILABLE);
  }

  function clone(row: FakeBatchRow): FakeBatchRow {
    return { ...row };
  }

  function parseIntervalMs(value: string): number {
    // Parse "60000" from params — the SQL uses ($N || ' milliseconds')::interval
    return Number(value);
  }

  async function query(text: string, params: any[] = []): Promise<{ rows: any[]; rowCount: number }> {
    const sql = text.replace(/\s+/g, " ").trim();

    if (sql.startsWith("INSERT INTO audit_log")) {
      state.audit_log.push({ id: auditSeq++, params });
      return { rows: [], rowCount: 1 };
    }

    // --- agent_batch_progress_item queries ---

    // writeItemCheckpoint: INSERT INTO agent_batch_progress_item ... ON CONFLICT DO UPDATE
    if (sql.startsWith("INSERT INTO agent_batch_progress_item")) {
      requireTable();
      const [batchKey, itemKey, status, error] = params;
      const existing = state.agent_batch_progress_items.find(
        (r) => r.batch_key === batchKey && r.item_key === itemKey
      );
      if (existing) {
        existing.status = status;
        existing.error = error ?? null;
        existing.processed_at = nowIso();
      } else {
        state.agent_batch_progress_items.push({
          batch_key: batchKey,
          item_key: itemKey,
          status: status,
          error: error ?? null,
          processed_at: nowIso(),
        });
      }
      return { rows: [], rowCount: 1 };
    }

    // Read already-processed items: SELECT item_key, status[, error] FROM agent_batch_progress_item WHERE batch_key = $1
    // Normalized SQL may have "batch_key=$1" or "batch_key = $1" — match either.
    if (sql.startsWith("SELECT item_key, status") && sql.includes("FROM agent_batch_progress_item") && sql.includes("WHERE batch_key")) {
      requireTable();
      const items = state.agent_batch_progress_items
        .filter((r) => r.batch_key === params[0])
        .map((r) => ({ item_key: r.item_key, status: r.status, error: r.error }));
      return { rows: items, rowCount: items.length };
    }

    // Delete per-item progress (when re-running a COMPLETED batch)
    if (sql.startsWith("DELETE FROM agent_batch_progress_item")) {
      requireTable();
      const batchKey = params[0];
      const before = state.agent_batch_progress_items.length;
      state.agent_batch_progress_items = state.agent_batch_progress_items.filter(r => r.batch_key !== batchKey);
      return { rows: [], rowCount: before - state.agent_batch_progress_items.length };
    }

    // Read batch counts: SELECT COUNT(*) ... FROM agent_batch_progress_item WHERE batch_key=$1
    if (sql.includes("COUNT(*)") && sql.includes("agent_batch_progress_item")) {
      requireTable();
      const items = state.agent_batch_progress_items.filter((r) => r.batch_key === params[0]);
      const processed = items.filter((r) => r.status === "PROCESSED").length;
      const failed = items.filter((r) => r.status === "FAILED").length;
      return {
        rows: [{ processed_count: String(processed + failed), succeeded_count: String(processed), failed_count: String(failed) }],
        rowCount: 1,
      };
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
      const [batchKey, agentName, orgId, totalItems, ownerId, leaseMs, actor, requestId] = params;
      const existing = state.agent_batch_progress.find((r) => r.batch_key === batchKey);
      const leaseExpiry = new Date(clock + parseIntervalMs(leaseMs)).toISOString();

      if (existing) {
        existing.agent_name = agentName;
        existing.org_id = orgId ?? existing.org_id;
        existing.status = "RUNNING";
        existing.total_items = Number(totalItems);
        existing.owner_id = ownerId;
        existing.lease_expires_at = leaseExpiry;
        existing.fencing_token = existing.fencing_token + 1;
        existing.attempts = existing.attempts + 1;
        existing.actor = actor;
        existing.request_id = requestId ?? null;
        existing.last_error = null;
        existing.completed_at = null;
        existing.heartbeat_at = nowIso();
        existing.updated_at = nowIso();
        return { rows: [clone(existing)], rowCount: 1 };
      } else {
        const row: FakeBatchRow = {
          batch_key: batchKey,
          agent_name: agentName,
          org_id: orgId ?? null,
          status: "RUNNING",
          total_items: Number(totalItems),
          resumed_count: 0,
          attempts: 1,
          owner_id: ownerId,
          lease_expires_at: leaseExpiry,
          fencing_token: 1,
          last_error: null,
          actor,
          request_id: requestId ?? null,
          started_at: nowIso(),
          heartbeat_at: nowIso(),
          completed_at: null,
          updated_at: nowIso(),
        };
        state.agent_batch_progress.push(row);
        return { rows: [clone(row)], rowCount: 1 };
      }
    }

    // --- startHeartbeat: UPDATE ... SET lease_expires_at = now() + interval, heartbeat_at = now() WHERE batch_key=$1 AND status='RUNNING' ---
    if (sql.includes("SET lease_expires_at = now()") && sql.includes("heartbeat_at = now()") && !sql.includes("fencing_token")) {
      const [batchKey, leaseMs] = params;
      const row = state.agent_batch_progress.find((r) => r.batch_key === batchKey && r.status === "RUNNING");
      if (!row) return { rows: [], rowCount: 0 };
      row.lease_expires_at = new Date(clock + parseIntervalMs(leaseMs)).toISOString();
      row.heartbeat_at = nowIso();
      return { rows: [], rowCount: 1 };
    }

    // --- persistCheckpoint: heartbeat + fencing (no JSONB) ---
    if (sql.includes("fencing_token = fencing_token + 1") && sql.includes("heartbeat_at = now()")) {
      const [batchKey, leaseMs, fencingToken] = params;
      const row = state.agent_batch_progress.find((r) => r.batch_key === batchKey);
      if (!row) return { rows: [], rowCount: 0 };
      // Fencing check: if the token doesn't match, return rowCount=0
      if (row.fencing_token !== Number(fencingToken)) {
        return { rows: [], rowCount: 0 };
      }
      row.heartbeat_at = nowIso();
      row.lease_expires_at = new Date(clock + parseIntervalMs(leaseMs)).toISOString();
      row.fencing_token = row.fencing_token + 1;
      row.updated_at = nowIso();
      return { rows: [], rowCount: 1 };
    }

    // --- finishBatch: with fencing ---
    if (sql.startsWith("UPDATE agent_batch_progress") && sql.includes("SET status = $2") && sql.includes("fencing_token = $3")) {
      const [batchKey, status, fencingToken] = params;
      const row = state.agent_batch_progress.find((r) => r.batch_key === batchKey);
      if (!row) return { rows: [], rowCount: 0 };
      // Fencing check
      if (row.fencing_token !== Number(fencingToken)) {
        return { rows: [], rowCount: 0 };
      }
      row.status = status as FakeBatchStatus;
      if (status === "COMPLETED" || status === "FAILED") row.completed_at = nowIso();
      row.heartbeat_at = nowIso();
      row.lease_expires_at = null;
      row.updated_at = nowIso();
      return { rows: [], rowCount: 1 };
    }

    // --- markBatchInterrupted: SET status='INTERRUPTED', lease_expires_at=NULL ---
    if (sql.startsWith("UPDATE agent_batch_progress") && sql.includes("SET status='INTERRUPTED'") && sql.includes("lease_expires_at=NULL")) {
      const [batchKey, reason] = params;
      const row = state.agent_batch_progress.find((r) => r.batch_key === batchKey && r.status === "RUNNING");
      if (!row) return { rows: [], rowCount: 0 };
      row.status = "INTERRUPTED";
      row.lease_expires_at = null;
      row.last_error = reason;
      row.updated_at = nowIso();
      return { rows: [], rowCount: 1 };
    }

    // --- update resumed_count: SET resumed_count = $2 ---
    if (sql.startsWith("UPDATE agent_batch_progress") && sql.includes("SET resumed_count")) {
      const [batchKey, resumedCount] = params;
      const row = state.agent_batch_progress.find((r) => r.batch_key === batchKey);
      if (!row) return { rows: [], rowCount: 0 };
      row.resumed_count = Number(resumedCount);
      row.updated_at = nowIso();
      return { rows: [], rowCount: 1 };
    }

    // --- recoverInterruptedBatches: reclaim RUNNING rows with expired lease ---
    if (sql.startsWith("UPDATE agent_batch_progress") && sql.includes("lease_expires_at < now()")) {
      const reclaimed = state.agent_batch_progress.filter(
        (r) => r.status === "RUNNING" && r.lease_expires_at !== null && new Date(r.lease_expires_at).getTime() < clock
      );
      for (const row of reclaimed) {
        row.status = "INTERRUPTED";
        row.owner_id = null;
        row.lease_expires_at = null;
        row.fencing_token = row.fencing_token + 1;
        row.last_error = row.last_error ?? "Reclaimed by supervisor: lease expired";
        row.updated_at = nowIso();
      }
      return {
        rows: reclaimed.map((r) => ({ batch_key: r.batch_key, agent_name: r.agent_name, fencing_token: r.fencing_token })),
        rowCount: reclaimed.length,
      };
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
    ageLease: (batchKey: string, ms: number) => {
      const row = state.agent_batch_progress.find((r) => r.batch_key === batchKey);
      if (!row) throw new Error(`Fake agent runtime DB: no batch row for key '${batchKey}'`);
      row.lease_expires_at = new Date(new Date(row.lease_expires_at ?? row.heartbeat_at).getTime() - ms).toISOString();
    },
    setTableAvailable: (available: boolean) => {
      tableAvailable = available;
    },
    rowFor: (batchKey: string) => state.agent_batch_progress.find((r) => r.batch_key === batchKey),
  };
}
