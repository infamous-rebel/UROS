import { Router, Request, Response, NextFunction } from "express";
import { z } from "zod";
import { authenticate } from "../middleware/auth";
import { rbac } from "../middleware/rbac";
import { validate } from "../middleware/validate";
import { createRateLimiter } from "../middleware/rate_limit";
import { db } from "../../database/client";
import {
  configureQuestionSet,
  createAndSendReferenceRequest,
  submitReferenceResponses,
  reviewReferenceResult,
  ReferenceLinkError,
} from "../../agents/reference_check_agent";
import { AGENT_NAMES, invoke } from "../../services/agent_runner/agents";

const router = Router();

const STAFF_READ_ROLES = ["ADMIN", "RECRUITER", "SENIOR_RECRUITER", "AUDITOR", "DEPT_HEAD"] as const;

const referenceRespondRateLimit = createRateLimiter("reference_respond", 10, 60_000);

// ---------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------

const QuestionTypeEnum = z.enum(["RATING_1_5", "YES_NO", "TEXT"]);

const QuestionSchema = z.object({
  question_id: z.string().min(1).max(100),
  text: z.string().min(1).max(1000),
  type: QuestionTypeEnum,
  weight: z.number().min(0).max(1000),
});

const ConfigureBodySchema = z.object({
  persona_id: z.string().uuid().nullable().optional(),
  name: z.string().min(1).max(200),
  questions: z.array(QuestionSchema).min(1).max(50),
});

const RequestBodySchema = z
  .object({
    candidate_id: z.string().min(1),
    referee_email: z.string().email().optional(),
    referee_phone: z.string().min(6).max(20).optional(),
    persona_id: z.string().uuid().optional(),
  })
  .refine((d) => !!d.referee_email || !!d.referee_phone, {
    message: "either referee_email or referee_phone must be provided",
    path: ["referee_email"],
  });

const CandidateIdParamSchema = z.object({ candidate_id: z.string().min(1) });
const RequestIdParamSchema = z.object({ request_id: z.string().uuid() });
const ResultIdParamSchema = z.object({ result_id: z.string().uuid() });
const TokenParamSchema = z.object({ token: z.string().regex(/^[a-f0-9]{64}$/, "malformed token") });

const RespondBodySchema = z.object({
  answers: z
    .array(
      z.object({
        question_id: z.string().min(1).max(100),
        response_text: z.string().max(5000),
      })
    )
    .min(1)
    .max(50),
});

const ReviewBodySchema = z.object({
  review_decision: z.enum(["APPROVED", "REJECTED", "ESCALATED"]),
  review_reason: z.string().min(1, "review_reason is mandatory"),
});

// ---------------------------------------------------------------------
// POST /api/v1/references/configure
// ---------------------------------------------------------------------

/**
 * Creates/replaces the active question set for a persona (or the org-wide
 * default when persona_id is omitted/null). Mirrors the fraud_checks /
 * dimension_configs versioning pattern: exactly one active set per
 * (org, persona) at a time.
 */
router.post(
  "/configure",
  authenticate,
  rbac("ADMIN", "DEPT_HEAD"),
  validate({ body: ConfigureBodySchema }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { persona_id, name, questions } = req.body as z.infer<typeof ConfigureBodySchema>;
      const questionSet = await configureQuestionSet(req.user!.org_id, persona_id ?? null, name, questions, req.user!.user_id);
      res.status(201).json({ question_set: questionSet });
    } catch (err) {
      next(err);
    }
  }
);

// ---------------------------------------------------------------------
// POST /api/v1/references/request
// ---------------------------------------------------------------------

/**
 * Creates a reference request for a candidate and immediately sends the
 * questionnaire to the referee via email or WhatsApp. Returns the
 * plaintext respond token/link exactly once — it is never persisted.
 */
router.post(
  "/request",
  authenticate,
  rbac("ADMIN", "RECRUITER", "SENIOR_RECRUITER"),
  validate({ body: RequestBodySchema }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const input = req.body as z.infer<typeof RequestBodySchema>;
      const { request, token } = await createAndSendReferenceRequest(input, req.user!.org_id, req.user!.user_id);

      res.status(201).json({
        request,
        respond_token: token,
        respond_url: `${req.protocol}://${req.get("host")}/api/v1/references/respond/${token}`,
      });
    } catch (err: any) {
      if (/not found/i.test(err?.message ?? "")) {
        res.status(404).json({ error: "Candidate not found" });
        return;
      }
      if (/failed to send/i.test(err?.message ?? "")) {
        res.status(502).json({ error: err.message });
        return;
      }
      next(err);
    }
  }
);

// ---------------------------------------------------------------------
// GET /api/v1/references/requests/:candidate_id
// ---------------------------------------------------------------------

/** Lists all reference requests for a candidate, with their result (if scored) joined in. */
router.get(
  "/requests/:candidate_id",
  authenticate,
  rbac(...STAFF_READ_ROLES),
  validate({ params: CandidateIdParamSchema }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { candidate_id } = req.params as unknown as z.infer<typeof CandidateIdParamSchema>;
      const orgId = req.user!.org_id;

      const candidateRes = await db.query(`SELECT candidate_id FROM candidates WHERE candidate_id=$1 AND org_id=$2`, [
        candidate_id,
        orgId,
      ]);
      if (candidateRes.rowCount === 0) {
        res.status(404).json({ error: "Candidate not found" });
        return;
      }

      const requestsRes = await db.query(
        `SELECT r.*, res.result_id, res.total_score, res.max_score, res.recommendation,
                res.review_decision, res.reviewed_at
         FROM reference_requests r
         LEFT JOIN reference_results res ON res.request_id = r.request_id
         WHERE r.candidate_id=$1 AND r.org_id=$2
         ORDER BY r.created_at DESC`,
        [candidate_id, orgId]
      );

      res.status(200).json({ requests: requestsRes.rows, count: requestsRes.rowCount });
    } catch (err) {
      next(err);
    }
  }
);

// ---------------------------------------------------------------------
// POST /api/v1/references/respond/:token  (PUBLIC — referee, no login)
// ---------------------------------------------------------------------

/**
 * Public endpoint used by the referee (external, unauthenticated) to
 * submit their answers. Rate-limited by IP. Any invalid/expired/
 * already-used token returns the same generic 404 so a resent link
 * cannot be distinguished from a forged one.
 */
router.post(
  "/respond/:token",
  referenceRespondRateLimit,
  validate({ params: TokenParamSchema, body: RespondBodySchema }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { token } = req.params as unknown as z.infer<typeof TokenParamSchema>;
      const { answers } = req.body as z.infer<typeof RespondBodySchema>;
      const result = await submitReferenceResponses(token, answers);
      res.status(200).json(result);
    } catch (err) {
      if (err instanceof ReferenceLinkError) {
        res.status(404).json({ error: err.message });
        return;
      }
      if (err instanceof Error && /unknown question_id/i.test(err.message)) {
        res.status(400).json({ error: err.message });
        return;
      }
      next(err);
    }
  }
);

// ---------------------------------------------------------------------
// POST /api/v1/references/requests/:request_id/score
// ---------------------------------------------------------------------

/**
 * Triggers deterministic scoring for a request that has received referee
 * responses (status=COMPLETED). Idempotent — safe to re-run; never
 * overwrites an existing human review decision.
 */
router.post(
  "/requests/:request_id/score",
  authenticate,
  rbac("ADMIN", "RECRUITER", "SENIOR_RECRUITER"),
  validate({ params: RequestIdParamSchema }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { request_id } = req.params as unknown as z.infer<typeof RequestIdParamSchema>;
      // Through the generic runner (Agent-Level Hardening). Reference
      // scoring evaluates one request's answers in a single deterministic
      // pass; the runner adds the timeout, retry, circuit, log and audit
      // trail without changing the errors the handler maps to 404/409.
      const result = await invoke(
        AGENT_NAMES.REFERENCE_CHECK_RUN_SCORING,
        { request_id, org_id: req.user!.org_id, actor_user_id: req.user!.user_id },
        {
          actor: req.user!.user_id,
          entity_type: "REFERENCE_REQUEST",
          entity_id: request_id,
          request_id: req.requestId,
        }
      );
      res.status(200).json({ result });
    } catch (err: any) {
      if (/not found/i.test(err?.message ?? "")) {
        res.status(404).json({ error: err.message });
        return;
      }
      if (/has not received/i.test(err?.message ?? "")) {
        res.status(409).json({ error: err.message });
        return;
      }
      next(err);
    }
  }
);

// ---------------------------------------------------------------------
// PATCH /api/v1/references/results/:result_id
// ---------------------------------------------------------------------

/**
 * The only path by which a reference result is ever finalized. A
 * mandatory review_reason is required for every decision (approve,
 * reject, or escalate), not only for overrides.
 */
router.patch(
  "/results/:result_id",
  authenticate,
  rbac("ADMIN", "RECRUITER", "SENIOR_RECRUITER"),
  validate({ params: ResultIdParamSchema, body: ReviewBodySchema }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { result_id } = req.params as unknown as z.infer<typeof ResultIdParamSchema>;
      const { review_decision, review_reason } = req.body as z.infer<typeof ReviewBodySchema>;
      const result = await reviewReferenceResult(result_id, req.user!.org_id, req.user!.user_id, review_decision, review_reason);
      res.status(200).json({ result });
    } catch (err: any) {
      if (/not found/i.test(err?.message ?? "")) {
        res.status(404).json({ error: err.message });
        return;
      }
      next(err);
    }
  }
);

export default router;
