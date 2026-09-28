import { Router, Request, Response, NextFunction } from "express";
import { z } from "zod";
import { authenticate } from "../middleware/auth";
import { rbac } from "../middleware/rbac";
import { validate } from "../middleware/validate";
import { communicationSendRateLimit } from "../middleware/rate_limit";
import { db } from "../../database/client";
import { logAudit } from "../../utils/audit_helper";
import * as communicationAgent from "../../agents/communication_agent";

const router = Router();

const SendBodySchema = z.object({
  candidate_ids: z.array(z.string().min(1)).min(1),
  channel: z.enum(["SMS", "EMAIL", "WHATSAPP"]),
  template_code: z.string().min(1),
});

/**
 * POST /api/v1/communications/send
 * Triggers a communication batch. Only ADMIN/RECRUITER may trigger sends;
 * every message is logged in communication_log + audit_log.
 */
router.post(
  "/send",
  authenticate,
  rbac("ADMIN", "RECRUITER"),
  communicationSendRateLimit,
  validate({ body: SendBodySchema }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { candidate_ids, channel, template_code } = req.body as z.infer<typeof SendBodySchema>;

      const candidatesRes = await db.query(
        `SELECT * FROM candidates WHERE candidate_id = ANY($1) AND org_id = $2`,
        [candidate_ids, req.user!.org_id]
      );

      if (candidatesRes.rowCount === 0) {
        res.status(404).json({ error: "No matching candidates found for this organization" });
        return;
      }

      await communicationAgent.sendBatch(candidatesRes.rows as any, template_code, channel, req.user!.org_id);

      await logAudit({
        entity_type: "COMMUNICATION",
        entity_id: template_code,
        agent_or_user: req.user!.user_id,
        action: "COMMUNICATION_BATCH_TRIGGERED",
        output_value: { recipients: candidatesRes.rowCount, template_code },
      });

      res.status(202).json({
        status: "SENT",
        recipients: candidatesRes.rowCount,
        template_code,
      });
    } catch (err) {
      next(err);
    }
  }
);

export default router;
