import { Router, Request, Response, NextFunction } from "express";
import { z } from "zod";
import { authenticate } from "../middleware/auth";
import { rbac } from "../middleware/rbac";
import { validate } from "../middleware/validate";
import { fetchAuditTrail, checkAuditConsistency } from "../../agents/audit_agent";
import { db } from "../../database/client";
import { logAudit } from "../../utils/audit_helper";

const router = Router();

const QuerySchema = z.object({
  entity_type: z.string().optional(),
  entity_id: z.string().optional(),
  agent_or_user: z.string().optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  limit: z.coerce.number().int().min(1).max(1000).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});

/**
 * GET /api/v1/audit-logs
 * Read-only query over the immutable audit trail. Auditor and Admin only.
 * Thin wrapper over the Audit Agent — all filter-building and query
 * logic lives in src/agents/audit_agent/index.ts.
 */
router.get(
  "/",
  authenticate,
  rbac("ADMIN", "AUDITOR"),
  validate({ query: QuerySchema }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const filters = req.query as unknown as z.infer<typeof QuerySchema>;
      const result = await fetchAuditTrail(req.user!.org_id, filters);
      res.status(200).json(result);
    } catch (err) {
      next(err);
    }
  }
);

const ConsistencyQuerySchema = z.object({ candidate_id: z.string().optional() });

/**
 * GET /api/v1/audit-logs/consistency-check
 * Read-only health check (Audit Agent requirement #2): verifies every
 * evaluation_results row has a corresponding audit_log entry. Never
 * writes — a genuine gap must be investigated/fixed by a human, not
 * silently patched here.
 */
router.get(
  "/consistency-check",
  authenticate,
  rbac("ADMIN", "AUDITOR"),
  validate({ query: ConsistencyQuerySchema }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { candidate_id } = req.query as z.infer<typeof ConsistencyQuerySchema>;
      const report = await checkAuditConsistency(req.user!.org_id, candidate_id);
      res.status(200).json({ report });
    } catch (err) {
      next(err);
    }
  }
);

// ─── Quest 05 Part 8: Audit Log Export ──────────────────────────────

/**
 * GET /api/v1/audit-logs/export
 * Export audit log entries as CSV or JSON. Admin/Auditor only.
 */
router.get(
  "/export",
  authenticate,
  rbac("ADMIN", "AUDITOR"),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const format = (req.query.format as string) ?? "csv";
      const from = req.query.from as string;
      const to = req.query.to as string;

      let query = `SELECT * FROM audit_log WHERE org_id = $1`;
      const params: unknown[] = [req.user!.org_id];
      if (from) { params.push(from); query += ` AND "timestamp" >= $${params.length}`; }
      if (to) { params.push(to); query += ` AND "timestamp" <= $${params.length}`; }
      query += ` ORDER BY "timestamp" DESC LIMIT 10000`;

      const logs = await db.query(query, params);

      await logAudit({
        org_id: req.user!.org_id,
        entity_type: "AUDIT_LOG",
        entity_id: "export",
        agent_or_user: req.user!.user_id,
        action: "FILE_DOWNLOADED",
        output_value: { format, resource: "audit_export", count: logs.rowCount },
      });

      const filename = `audit-log-export.${format}`;

      if (format === "csv") {
        const header = "audit_id,entity_type,entity_id,agent_or_user,action,reason_code,reason_comment,timestamp";
        const rows = logs.rows.map((l: any) =>
          `${l.audit_id},${l.entity_type ?? ""},${l.entity_id ?? ""},${l.agent_or_user ?? ""},${l.action ?? ""},${l.reason_code ?? ""},"${(l.reason_comment ?? "").replace(/"/g, '""')}","${l.timestamp ?? ""}"`
        );
        const csv = [header, ...rows].join("\n");
        res.setHeader("Content-Type", "text/csv");
        res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
        res.send(csv);
      } else {
        res.setHeader("Content-Type", "application/json");
        res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
        res.json({ entries: logs.rows, count: logs.rowCount });
      }
    } catch (err) { next(err); }
  }
);

export default router;
