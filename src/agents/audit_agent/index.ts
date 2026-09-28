import { db } from "../../database/client";
import { AuditLogEntry } from "../../models/audit_log.model";

/**
 * READ-ONLY by design. Writing audit entries is exclusively
 * utils/audit_helper.ts's `logAudit()` — every other agent/route in the
 * system already calls that directly, and this agent must not introduce
 * a second write path (that would risk two divergent ways of producing
 * the same immutable trail). This module only queries and validates
 * what `logAudit` has already written.
 */

export interface AuditTrailFilters {
  entity_type?: string;
  entity_id?: string;
  agent_or_user?: string;
  action?: string;
  from?: string; // ISO datetime
  to?: string; // ISO datetime
  limit?: number;
  offset?: number;
}

export interface AuditTrailResult {
  entries: AuditLogEntry[];
  limit: number;
  offset: number;
  count: number;
}

/**
 * Safely queries the immutable audit_log table with the same filter
 * set audit.routes.ts already exposes over HTTP — extracted here as the
 * single reusable implementation so the route becomes a thin wrapper
 * over this function instead of duplicating the filter-building logic.
 * All filter values are parameterized; nothing here interpolates
 * caller input directly into SQL.
 */
export async function fetchAuditTrail(filters: AuditTrailFilters = {}): Promise<AuditTrailResult> {
  const limit = Math.min(Math.max(filters.limit ?? 100, 1), 1000);
  const offset = Math.max(filters.offset ?? 0, 0);

  const conditions: string[] = ["1=1"];
  const params: unknown[] = [];

  if (filters.entity_type) {
    params.push(filters.entity_type);
    conditions.push(`entity_type = $${params.length}`);
  }
  if (filters.entity_id) {
    params.push(filters.entity_id);
    conditions.push(`entity_id = $${params.length}`);
  }
  if (filters.agent_or_user) {
    params.push(filters.agent_or_user);
    conditions.push(`agent_or_user = $${params.length}`);
  }
  if (filters.action) {
    params.push(filters.action);
    conditions.push(`action = $${params.length}`);
  }
  if (filters.from) {
    params.push(filters.from);
    conditions.push(`timestamp >= $${params.length}`);
  }
  if (filters.to) {
    params.push(filters.to);
    conditions.push(`timestamp <= $${params.length}`);
  }

  params.push(limit);
  params.push(offset);

  const result = await db.query<AuditLogEntry>(
    `SELECT * FROM audit_log
     WHERE ${conditions.join(" AND ")}
     ORDER BY timestamp DESC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );

  return { entries: result.rows, limit, offset, count: result.rowCount ?? result.rows.length };
}

/** Fetches the full audit trail for a single entity, oldest first (a readable "history" view), no pagination — bounded to 1000 rows as a safety cap. */
export async function fetchEntityHistory(entityType: string, entityId: string): Promise<AuditLogEntry[]> {
  const result = await db.query<AuditLogEntry>(
    `SELECT * FROM audit_log WHERE entity_type=$1 AND entity_id=$2 ORDER BY timestamp ASC LIMIT 1000`,
    [entityType, entityId]
  );
  return result.rows;
}

// ---------------------------------------------------------------------
// Consistency check — read + compare only, never writes. Verifies that
// every evaluation_results row has a corresponding audit_log entry, so
// gaps in the immutable trail (a symptom of a bypassed logAudit call,
// a failed write that violated the "never throws" contract in an
// unexpected way, or manual DB tampering) are detectable rather than
// silently trusted.
// ---------------------------------------------------------------------

export interface AuditConsistencyReport {
  candidate_id: string | null;
  evaluation_result_count: number;
  matching_audit_entry_count: number;
  consistent: boolean;
  missing_evaluation_ids: string[]; // evaluation_results.evaluation_id values with no matching audit_log entry
}

/**
 * Cross-checks evaluation_results against audit_log for a candidate (or
 * system-wide when candidateId is omitted, bounded to the most recent
 * 5000 evaluations to keep this a cheap health check rather than a full
 * table scan). A row is considered "matched" if an audit_log entry
 * exists with entity_type='EVALUATION', the same entity_id
 * (candidate_id), action='RULE_EVALUATED', and a timestamp at or after
 * the evaluation's evaluated_at — matching how evaluator.ts's `persist()`
 * always writes both in the same call, evaluation_results row first.
 */
export async function checkAuditConsistency(candidateId?: string): Promise<AuditConsistencyReport> {
  const scopeClause = candidateId ? "WHERE er.candidate_id=$1" : "";
  const scopeParams = candidateId ? [candidateId] : [];

  const totalRes = await db.query(`SELECT COUNT(*)::int AS count FROM evaluation_results er ${scopeClause}`, scopeParams);
  const totalCount = totalRes.rows[0]?.count ?? 0;

  // A single set-based query rather than one audit_log lookup per
  // evaluation row — cheap even at scale, still read-only.
  const missingRes = await db.query(
    `SELECT er.evaluation_id
     FROM evaluation_results er
     ${scopeClause}
     ${candidateId ? "AND" : "WHERE"} NOT EXISTS (
       SELECT 1 FROM audit_log al
       WHERE al.entity_type='EVALUATION' AND al.entity_id=er.candidate_id
         AND al.action='RULE_EVALUATED' AND al.timestamp >= er.evaluated_at
     )
     ORDER BY er.evaluated_at DESC
     LIMIT 5000`,
    scopeParams
  );

  const missing = missingRes.rows.map((r: any) => r.evaluation_id);

  return {
    candidate_id: candidateId ?? null,
    evaluation_result_count: totalCount,
    matching_audit_entry_count: totalCount - missing.length,
    consistent: missing.length === 0,
    missing_evaluation_ids: missing,
  };
}
