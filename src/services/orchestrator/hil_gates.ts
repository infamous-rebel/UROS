import { db } from "../../database/client";
import { logAudit } from "../../utils/audit_helper";
import { env } from "../../config/env.schema";
import { gateListener } from "./gate_listener";

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
export async function createGate(batchId: string, gateType: string, orgId: string): Promise<string> {
  const res = await db.query<{ gate_id: string }>(
    `INSERT INTO gate_events (batch_id, gate_type, org_id, status)
     VALUES ($1, $2, $3, 'PENDING') RETURNING gate_id`,
    [batchId, gateType, orgId]
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

  const fullPayload = { decision, ...(typeof payload === "object" && payload !== null ? payload : { value: payload }) };

  const updated = await db.query<{ resolved_at: string }>(
    `UPDATE gate_events
     SET status='RESOLVED', resolved_by=$1, payload=$2, resolved_at=now()
     WHERE gate_id=$3
     RETURNING resolved_at`,
    [resolvedBy, JSON.stringify(fullPayload), gateId]
  );

  // Production hook: notify any LISTEN-ing worker that this gate resolved.
  await db.query(`SELECT pg_notify('gate_resolved', $1)`, [gateId]);

  await logAudit({
    entity_type: "GATE",
    entity_id: gateId,
    agent_or_user: resolvedBy,
    action: "GATE_RESOLVED",
    reason_code: decision,
    output_value: fullPayload,
  });

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
