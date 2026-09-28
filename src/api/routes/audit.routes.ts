import { Router, Request, Response, NextFunction } from "express";
import { z } from "zod";
import { authenticate } from "../middleware/auth";
import { rbac } from "../middleware/rbac";
import { validate } from "../middleware/validate";
import { fetchAuditTrail, checkAuditConsistency } from "../../agents/audit_agent";

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
      const result = await fetchAuditTrail(filters);
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
      const report = await checkAuditConsistency(candidate_id);
      res.status(200).json({ report });
    } catch (err) {
      next(err);
    }
  }
);

export default router;
