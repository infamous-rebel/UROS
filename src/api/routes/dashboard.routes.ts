/**
 * Dashboard routes — Quest 05 Part 2 CommandBar.
 *
 * GET /summary: live counts for the status summary chips (Auto-Pass,
 * Auto-Fail, Needs Review, Overdue gates). Polled by the UI.
 *
 * GET /circulars: distinct job circular IDs with candidate counts, for
 * the circular/batch selector dropdown.
 */
import { Router, Request, Response, NextFunction } from "express";
import { authenticate } from "../middleware/auth";
import { rbac } from "../middleware/rbac";
import { db } from "../../database/client";

const router = Router();

/**
 * GET /api/v1/dashboard/summary — Quest 05 Part 2 "Live status summary".
 * Counts are org-scoped and exclude withdrawn candidates.
 */
router.get(
  "/summary",
  authenticate,
  rbac("RECRUITER", "SENIOR_RECRUITER", "ADMIN", "DEPT_HEAD", "AUDITOR"),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const orgId = req.user!.org_id;

      // Candidate status counts (single query, GROUP BY).
      const statusCounts = await db.query<{ status: string; count: string }>(
        `SELECT status, count(*)::text AS count
         FROM candidates
         WHERE org_id = $1 AND status != 'WITHDRAWN'
         GROUP BY status`,
        [orgId]
      );

      const counts: Record<string, number> = {};
      for (const row of statusCounts.rows) {
        counts[row.status] = parseInt(row.count, 10);
      }

      // Auto-Pass: candidates that passed the pipeline (approved/shortlisted/verified/selected).
      const auto_pass =
        (counts["ELIGIBLE_APPROVED"] ?? 0) +
        (counts["SHORTLISTED"] ?? 0) +
        (counts["VERIFIED"] ?? 0) +
        (counts["SELECTED"] ?? 0);

      // Auto-Fail: rejected candidates.
      const auto_fail = counts["REJECTED"] ?? 0;

      // Needs Review: candidates awaiting human decision.
      const needs_review = counts["NEEDS_REVIEW"] ?? 0;

      // Overdue gates: PENDING gates older than 24 hours.
      const overdueGates = await db.query<{ count: string }>(
        `SELECT count(*)::text AS count
         FROM gate_events
         WHERE org_id = $1 AND status = 'PENDING' AND created_at < now() - interval '24 hours'`,
        [orgId]
      );
      const overdue_gates = parseInt(overdueGates.rows[0]?.count ?? "0", 10);

      res.status(200).json({ auto_pass, auto_fail, needs_review, overdue_gates });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * GET /api/v1/dashboard/circulars — Quest 05 Part 2 "Circular/batch selector".
 * Distinct job_circular_id values from candidates with counts, for the
 * dropdown that scopes other panels.
 */
router.get(
  "/circulars",
  authenticate,
  rbac("RECRUITER", "SENIOR_RECRUITER", "ADMIN", "DEPT_HEAD", "AUDITOR"),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const orgId = req.user!.org_id;
      const result = await db.query<{ circular_id: string; candidates: string }>(
        `SELECT job_circular_id AS circular_id, count(*)::text AS candidates
         FROM candidates
         WHERE org_id = $1 AND job_circular_id IS NOT NULL
         GROUP BY 1
         ORDER BY 2 DESC
         LIMIT 50`,
        [orgId]
      );
      const circulars = result.rows.map((r) => ({
        circular_id: r.circular_id,
        candidates: parseInt(r.candidates, 10),
      }));
      res.status(200).json({ circulars });
    } catch (err) {
      next(err);
    }
  }
);

export default router;
