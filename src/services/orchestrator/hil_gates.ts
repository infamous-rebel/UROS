import { db } from "../../database/client";
import { logAudit } from "../../utils/audit_helper";
import { env } from "../../config/env.schema";
import { gateListener } from "./gate_listener";
import { logger } from "../../utils/logger";

/**
 * Creates a PENDING gate_event and blocks (via polling in this reference
 * implementation; production should use LISTEN/NOTIFY or a queue consumer
 * triggered by POST /api/v1/gates/:id/resolve) until a human resolves it.
 */
/**
 * Creates a PENDING gate_event and blocks (via polling in this reference
 * implementation; production should use LISTEN/NOTIFY or a queue consumer
 * triggered by POST /api/v1/gates/:id/resolve) until a human resolves it.
 *
 * Security Hardening Round: orgId is now mandatory and stored on the row
 * (see migration 0022_gate_org_id.sql) so resolveGate can enforce that a
 * gate is only ever resolved by a human from the same org that created it.
 */
export async function createGate(
  batchId: string,
  gateType: string,
  orgId: string,
  payload?: unknown
): Promise<string> {
  const res = await db.query<{ gate_id: string }>(
    `INSERT INTO gate_events (batch_id, gate_type, org_id, status, payload)
     VALUES ($1, $2, $3, 'PENDING', $4) RETURNING gate_id`,
    [batchId, gateType, orgId, payload ? JSON.stringify(payload) : null]
  );
  await logAudit({
    entity_type: "GATE",
    entity_id: res.rows[0].gate_id,
    agent_or_user: "Orchestrator",
    action: "GATE_CREATED",
    reason_code: gateType,
  });
  return res.rows[0].gate_id;
}

export type GateDecision = "APPROVE" | "REJECT" | "OVERRIDE";

export interface ResolveGateResult {
  gate_id: string;
  status: "RESOLVED";
  decision: GateDecision;
  payload: unknown;
  resolved_by: string;
  resolved_at: string;
}

/**
 * Resolves a pending human gate: marks it RESOLVED, stores the decision +
 * payload, and signals waiters via `pg_notify` on the `gate_resolved`
 * channel. `waitForHumanGate` (below) subscribes to this channel via
 * `gateListener` and resolves immediately on notification, with a
 * database re-check as a race-safety net and a hard timeout fallback.
 *
 * Security Hardening Round: orgId is mandatory and checked against the
 * gate's stored org_id. A mismatch (including a pre-migration row whose
 * org_id is NULL, which can never equal a real org_id) is treated
 * identically to "not found" — never a 403 — so a caller outside the
 * gate's org cannot even confirm the gate exists.
 */
export async function resolveGate(
  gateId: string,
  decision: GateDecision,
  payload: unknown,
  resolvedBy: string,
  orgId: string
): Promise<ResolveGateResult> {
  const existing = await db.query<{ status: string; org_id: string | null }>(
    `SELECT status, org_id FROM gate_events WHERE gate_id=$1 AND org_id=$2`,
    [gateId, orgId]
  );
  if (existing.rowCount === 0) {
    throw new Error(`Gate not found: ${gateId}`);
  }
  if (existing.rows[0].status === "RESOLVED") {
    throw new Error(`Gate already resolved: ${gateId}`);
  }

  // Resolve the human's name for the audit trail (Quest 03).
  const nameRes = await db.query<{ full_name: string }>(
    `SELECT full_name FROM users WHERE user_id=$1`,
    [resolvedBy]
  );
  const resolvedByName = nameRes.rows[0]?.full_name ?? resolvedBy;

  const fullPayload = { decision, ...(typeof payload === "object" && payload !== null ? payload : { value: payload }) };

  const updated = await db.query<{ resolved_at: string }>(
    `UPDATE gate_events
     SET status='RESOLVED', resolved_by=$1, payload=$2, resolved_at=now(), resolved_by_name=$4
     WHERE gate_id=$3
     RETURNING resolved_at`,
    [resolvedBy, JSON.stringify(fullPayload), gateId, resolvedByName]
  );

  // Production hook: notify any LISTEN-ing worker that this gate resolved.
  await db.query(`SELECT pg_notify('gate_resolved', $1)`, [gateId]);

  await logAudit({
    org_id: orgId,
    entity_type: "GATE",
    entity_id: gateId,
    agent_or_user: resolvedBy,
    action: "GATE_RESOLVED",
    reason_code: decision,
    output_value: fullPayload,
  });

  // Quest 03: enqueue a CONTINUE_FROM_GATE job so the pipeline resumes
  // asynchronously instead of blocking the resolving request.
  await enqueueContinuationJob(gateId, orgId, resolvedByName);

  return {
    gate_id: gateId,
    status: "RESOLVED",
    decision,
    payload: fullPayload,
    resolved_by: resolvedBy,
    resolved_at: updated.rows[0].resolved_at,
  };
}

/**
 * Blocks (without polling) until a human resolves the gate, via
 * `gateListener` subscribed to Postgres `LISTEN gate_resolved`. Falls
 * back to a hard timeout (default `env.GATE_TIMEOUT_MS`, 30 days) so a
 * pipeline can never hang forever on an abandoned gate — after timeout,
 * the gate row itself remains PENDING and resolvable later; only this
 * particular wait call gives up.
 */
export async function waitForHumanGate(
  batchId: string,
  gateType: string,
  orgId: string,
  timeoutMs: number = env.GATE_TIMEOUT_MS
): Promise<unknown> {
  const gateId = await createGate(batchId, gateType, orgId);
  return gateListener.waitFor(gateId, timeoutMs);
}

/**
 * Lists all PENDING gates for an org, newest first.
 * Used by the gate inbox UI (Quest 03).
 */
export async function listPendingGates(orgId: string): Promise<Array<{
  gate_id: string;
  batch_id: string;
  gate_type: string;
  org_id: string;
  payload: unknown;
  created_at: string;
}>> {
  const res = await db.query(
    `SELECT gate_id, batch_id, gate_type, org_id, payload, created_at
     FROM gate_events
     WHERE org_id=$1 AND status='PENDING'
     ORDER BY created_at DESC`,
    [orgId]
  );
  return res.rows.map((r) => ({
    gate_id: r.gate_id,
    batch_id: r.batch_id,
    gate_type: r.gate_type,
    org_id: r.org_id,
    payload: typeof r.payload === "string" ? JSON.parse(r.payload) : r.payload,
    created_at: r.created_at,
  }));
}

/**
 * After a gate is resolved, enqueues a CONTINUE_FROM_GATE evaluation job
 * so the pipeline resumes asynchronously. Looks up the batch context
 * (circular_id, rule_pack_version_id) from the candidates table.
 */
async function enqueueContinuationJob(gateId: string, orgId: string, resolvedByName: string): Promise<void> {
  // Look up the gate's batch context.
  const gateRes = await db.query<{ batch_id: string; gate_type: string }>(
    `SELECT batch_id, gate_type FROM gate_events WHERE gate_id=$1`,
    [gateId]
  );
  if (gateRes.rowCount === 0) return;
  const { batch_id, gate_type } = gateRes.rows[0];

  // Derive circular_id and rule_pack_version_id from the batch's candidates
  // and evaluation_results, respectively. Falls back to empty/zero UUIDs.
  const ctxRes = await db.query<{ job_circular_id: string; rule_pack_version_id: string }>(
    `SELECT
       (SELECT DISTINCT job_circular_id FROM candidates WHERE org_id=$1 LIMIT 1) AS job_circular_id,
       (SELECT DISTINCT rule_pack_version_id FROM evaluation_results
        JOIN candidates c ON c.candidate_id = evaluation_results.candidate_id
        WHERE c.org_id=$1 LIMIT 1) AS rule_pack_version_id`,
    [orgId]
  );
  const circularId = ctxRes.rows[0]?.job_circular_id ?? "";
  const rulePackVersionId = ctxRes.rows[0]?.rule_pack_version_id ?? "00000000-0000-0000-0000-000000000000";

  try {
    await db.query(
      `INSERT INTO evaluation_jobs
        (batch_id, circular_id, rule_pack_version_id, org_id, stage, gate_id, requested_by_name, status)
       VALUES ($1, $2, $3, $4, 'CONTINUE_FROM_GATE', $5, $6, 'QUEUED')`,
      [batch_id, circularId, rulePackVersionId, orgId, gateId, resolvedByName]
    );
    logger.info("CONTINUE_FROM_GATE_ENQUEUED", { gateId, batch_id, gate_type });
  } catch (err: any) {
    // Dedup: if a CONTINUE_FROM_GATE job already exists for this gate, skip.
    if (err?.code === "23505") {
      logger.info("CONTINUE_FROM_GATE_DEDUP", { gateId });
      return;
    }
    throw err;
  }
}
