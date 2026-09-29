/**
 * Notification routes — Quest 05 Part 2 CommandBar bell.
 *
 * GET / — grouped previews of pending gates, overdue tasks, and failed
 * deliveries. Poll-based (no WebSocket — that's Quest 08). The UI polls
 * this every 15s when focused, 60s when backgrounded.
 */
import { Router, Request, Response, NextFunction } from "express";
import { authenticate } from "../middleware/auth";
import { rbac } from "../middleware/rbac";
import { db } from "../../database/client";
import { listPendingGates } from "../../services/orchestrator/hil_gates";

const router = Router();

/**
 * GET /api/v1/notifications — Quest 05 Part 2 "Notification bell".
 * Three groups: pending gates, overdue tasks, failed deliveries.
 * Each group returns a count + top 5 preview items.
 */
router.get(
  "/",
  authenticate,
  rbac("RECRUITER", "SENIOR_RECRUITER", "ADMIN", "DEPT_HEAD", "AUDITOR"),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const orgId = req.user!.org_id;

      // Pending gates (reuse the existing service function).
      const gates = await listPendingGates(orgId);
      const gatesPreview = gates.slice(0, 5).map((g) => ({
        gate_id: g.gate_id,
        gate_type: g.gate_type,
        batch_id: g.batch_id,
        created_at: g.created_at,
      }));

      // Overdue tasks: TODO/IN_PROGRESS/BLOCKED with due_date in the past.
      const overdueTasks = await db.query<{
        task_id: string;
        title: string;
        due_date: string;
        priority: string;
      }>(
        `SELECT task_id, title, due_date, priority
         FROM task_logs
         WHERE org_id = $1 AND status IN ('TODO','IN_PROGRESS','BLOCKED') AND due_date < now()
         ORDER BY due_date ASC
         LIMIT 5`,
        [orgId]
      );
      const overdueTaskCount = await db.query<{ count: string }>(
        `SELECT count(*)::text AS count
         FROM task_logs
         WHERE org_id = $1 AND status IN ('TODO','IN_PROGRESS','BLOCKED') AND due_date < now()`,
        [orgId]
      );

      // Failed deliveries: communication_log with status='FAILED', scoped via candidate join.
      const failedDeliveries = await db.query<{
        message_id: string;
        channel: string;
        template_code: string;
        sent_at: string;
      }>(
        `SELECT cl.message_id, cl.channel, cl.template_code, cl.sent_at
         FROM communication_log cl
         JOIN candidates c ON cl.candidate_id = c.candidate_id
         WHERE c.org_id = $1 AND cl.status = 'FAILED'
         ORDER BY cl.sent_at DESC
         LIMIT 5`,
        [orgId]
      );
      const failedDeliveryCount = await db.query<{ count: string }>(
        `SELECT count(*)::text AS count
         FROM communication_log cl
         JOIN candidates c ON cl.candidate_id = c.candidate_id
         WHERE c.org_id = $1 AND cl.status = 'FAILED'`,
        [orgId]
      );

      const total =
        gates.length +
        parseInt(overdueTaskCount.rows[0]?.count ?? "0", 10) +
        parseInt(failedDeliveryCount.rows[0]?.count ?? "0", 10);

      res.status(200).json({
        total,
        groups: {
          gates: { count: gates.length, items: gatesPreview },
          tasks: {
            count: parseInt(overdueTaskCount.rows[0]?.count ?? "0", 10),
            items: overdueTasks.rows,
          },
          deliveries: {
            count: parseInt(failedDeliveryCount.rows[0]?.count ?? "0", 10),
            items: failedDeliveries.rows,
          },
        },
      });
    } catch (err) {
      next(err);
    }
  }
);

export default router;
