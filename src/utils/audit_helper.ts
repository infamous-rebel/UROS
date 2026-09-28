import { db } from "../database/client";
import { logger } from "./logger";
import { metrics } from "./metrics";
import { AuditLogEntry } from "../models/audit_log.model";

/**
 * Logs an immutable audit entry. Never throws — audit failures must not
 * block the recruitment pipeline. Failures are logged to the application
 * logger and, in production, should also raise an ops alert.
 *
 * Quest 02: scope column distinguishes TENANT (org-scoped, org_id
 * required) from SYSTEM (infrastructure-level, org_id null). Default
 * is TENANT — callers without org context must explicitly pass scope='SYSTEM'.
 */
export async function logAudit(entry: AuditLogEntry): Promise<void> {
  const scope = entry.scope ?? (entry.org_id ? "TENANT" : "SYSTEM");
  try {
    await db.query(
      `INSERT INTO audit_log
        (org_id, scope, entity_type, entity_id, agent_or_user, action, rule_id,
         input_value, output_value, reason_code, reason_comment)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [
        entry.org_id ?? null,
        scope,
        entry.entity_type,
        entry.entity_id,
        entry.agent_or_user,
        entry.action,
        entry.rule_id ?? null,
        JSON.stringify(entry.input_value ?? null),
        JSON.stringify(entry.output_value ?? null),
        entry.reason_code ?? null,
        entry.reason_comment ?? null,
      ]
    );
    // Single instrumentation point for every audited action in the system
    // (gates, evaluations, overrides, rule changes, task/onboarding
    // reminders, credential writes, ...) — anything that calls logAudit
    // is automatically visible in /metrics without per-call-site wiring.
    metrics.auditLogWritesTotal.inc({ entity_type: entry.entity_type, action: entry.action });
  } catch (err) {
    logger.error("AUDIT_WRITE_FAILED", {
      error: err instanceof Error ? err.message : String(err),
      entry,
    });
    // Deliberately swallowed — see docstring.
  }
}
