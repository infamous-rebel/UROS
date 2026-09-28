import { Router, Request, Response, NextFunction } from "express";
import { z } from "zod";
import { authenticate } from "../middleware/auth";
import { rbac } from "../middleware/rbac";
import { validate } from "../middleware/validate";
import { resolveGate, listPendingGates } from "../../services/orchestrator/hil_gates";

const router = Router();

const GateIdParamSchema = z.object({ gateId: z.string().uuid() });

const ResolveBodySchema = z.object({
  decision: z.enum(["APPROVE", "REJECT", "OVERRIDE"]),
  payload: z.unknown().optional(),
  reason_comment: z.string().optional(),
}).refine(
  (data) => data.decision !== "OVERRIDE" || (data.reason_comment && data.reason_comment.trim().length > 0),
  { message: "reason_comment is mandatory when decision is OVERRIDE", path: ["reason_comment"] }
);

/**
 * GET /api/v1/gates
 * Quest 03: Gate discovery / inbox. Lists all PENDING gates for the
 * caller's org, newest first. The UI polls this to show humans what
 * decisions are waiting.
 */
router.get(
  "/",
  authenticate,
  rbac("RECRUITER", "SENIOR_RECRUITER", "ADMIN", "DEPT_HEAD", "AUDITOR"),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const gates = await listPendingGates(req.user!.org_id);
      res.status(200).json({ gates });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * POST /api/v1/gates/:gateId/resolve
 * Resolves a pending human-in-the-loop gate created by the orchestrator
 * (import approval, eligibility review, shortlist confirmation, verification
 * sign-off, communication approval, final approval).
 */
router.post(
  "/:gateId/resolve",
  authenticate,
  rbac("RECRUITER", "SENIOR_RECRUITER", "ADMIN", "DEPT_HEAD"),
  validate({ params: GateIdParamSchema, body: ResolveBodySchema }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { gateId } = req.params as unknown as z.infer<typeof GateIdParamSchema>;
      const { decision, payload, reason_comment } = req.body as z.infer<typeof ResolveBodySchema>;

      const result = await resolveGate(
        gateId,
        decision,
        { ...(typeof payload === "object" && payload !== null ? payload : {}), reason_comment },
        req.user!.user_id,
        req.user!.org_id
      );

      res.status(200).json(result);
    } catch (err) {
      if (err instanceof Error && err.message.startsWith("Gate not found")) {
        res.status(404).json({ error: err.message });
        return;
      }
      if (err instanceof Error && err.message.startsWith("Gate already resolved")) {
        res.status(409).json({ error: err.message });
        return;
      }
      next(err);
    }
  }
);

export default router;
