import { Router, Request, Response, NextFunction } from "express";
import { z } from "zod";
import jwt from "jsonwebtoken";
import { authenticate } from "../middleware/auth";
import { rbac } from "../middleware/rbac";
import { validate } from "../middleware/validate";
import { createRateLimiter } from "../middleware/rate_limit";
import { env } from "../../config/env.schema";
import { logger } from "../../utils/logger";
import { db } from "../../database/client";
import { AuthenticatedUser } from "../types/express";
import {
  setRediscoveryConsent,
  getRediscoveryConsent,
  verifyConsentToken,
  listRediscoverySuggestions,
  reviewSuggestion,
  listRediscoveryOutreach,
  DEFAULT_RUN_PARAMS,
  RediscoveryReviewError,
} from "../../agents/rediscovery_agent";
import { AGENT_NAMES, invoke } from "../../services/agent_runner/agents";

const router = Router();

const STAFF_ROLES = ["ADMIN", "RECRUITER", "SENIOR_RECRUITER", "DEPT_HEAD"] as const;
const STAFF_READ_ROLES = ["ADMIN", "RECRUITER", "SENIOR_RECRUITER", "AUDITOR", "DEPT_HEAD"] as const;
const RUN_ROLES = ["ADMIN", "SENIOR_RECRUITER"] as const;

const consentPublicRateLimit = createRateLimiter("rediscovery_consent_public", 20, 60_000);

// ---------------------------------------------------------------------
// Optional authentication (internal staff OR public token, never both required)
// ---------------------------------------------------------------------

/**
 * Same Bearer-JWT verification as middleware/auth.ts, but tolerant of a
 * missing/invalid header: it sets req.user when a valid staff token is
 * present and otherwise simply calls next() unauthenticated, leaving
 * the route handler to fall back to token-based public consent. This
 * lets POST /rediscovery/consent serve both "staff recording consent on
 * a candidate's behalf" and "candidate submitting consent via their own
 * public link" from a single endpoint, per spec.
 */
function optionalAuthenticate(req: Request, _res: Response, next: NextFunction): void {
  const header = req.headers.authorization;
  if (!header || !header.startsWith("Bearer ")) {
    next();
    return;
  }
  try {
    const decoded = jwt.verify(header.slice("Bearer ".length).trim(), env.JWT_SECRET) as AuthenticatedUser & {
      iat?: number;
      exp?: number;
    };
    if (decoded.user_id && decoded.org_id && decoded.role) {
      req.user = { user_id: decoded.user_id, org_id: decoded.org_id, role: decoded.role };
    }
  } catch (err) {
    // Invalid/expired token on this route is not fatal — treat as
    // unauthenticated (public) rather than rejecting, since a token
    // param may still be supplied. Logged for observability only.
    logger.warn("REDISCOVERY_OPTIONAL_AUTH_IGNORED", {
      path: req.path,
      error: err instanceof Error ? err.message : String(err),
    });
  }
  next();
}

// ---------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------

const ConsentBodySchema = z.object({
  candidate_id: z.string().min(1),
  opted_in: z.boolean(),
  token: z.string().regex(/^[a-f0-9]{64}$/, "malformed token").optional(),
});

const CandidateIdParamSchema = z.object({ candidate_id: z.string().min(1) });

const RunBodySchema = z.object({
  target_circular_id: z.string().min(1).max(200),
  target_position: z.string().max(300).nullable().optional(),
  persona_id: z.string().uuid(),
  min_fit_score: z.number().min(0).max(100).default(DEFAULT_RUN_PARAMS.min_fit_score),
  min_days_since_decision: z.number().int().min(0).max(3650).default(DEFAULT_RUN_PARAMS.min_days_since_decision),
  require_opt_in: z.boolean().default(DEFAULT_RUN_PARAMS.require_opt_in),
  max_candidates: z.number().int().min(1).max(2000).default(DEFAULT_RUN_PARAMS.max_candidates),
});

const SuggestionsQuerySchema = z.object({
  target_circular_id: z.string().min(1).optional(),
  status: z.enum(["PENDING_REVIEW", "APPROVED", "REJECTED"]).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

const SuggestionIdParamSchema = z.object({ suggestion_id: z.string().uuid() });

const ReviewBodySchema = z.object({
  action: z.enum(["APPROVE", "REJECT"]),
  reason: z.string().min(1, "reason is mandatory"),
});

const OutreachBodySchema = z.object({
  suggestion_ids: z.array(z.string().uuid()).min(1).max(100),
  channel: z.enum(["SMS", "EMAIL", "WHATSAPP"]),
  template_code: z.string().min(1).max(200),
});

const OutreachQuerySchema = z.object({
  suggestion_id: z.string().uuid().optional(),
  target_circular_id: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

// ---------------------------------------------------------------------
// POST /api/v1/rediscovery/consent
// ---------------------------------------------------------------------

/**
 * Candidate opt-in/opt-out. Two supported callers, both audited:
 *  - Staff (Bearer JWT, STAFF_ROLES): records consent on the candidate's
 *    behalf, org-scoped to req.user.org_id.
 *  - Public (no auth header): must supply the candidate's `token`
 *    (see rediscovery_agent.generateConsentToken) proving the request
 *    came from a link only that candidate received. The candidate's
 *    org is looked up from the candidate record itself — candidate_id
 *    alone is not secret, but the token cannot be forged without
 *    env.JWT_SECRET.
 */
router.post(
  "/consent",
  consentPublicRateLimit,
  optionalAuthenticate,
  validate({ body: ConsentBodySchema }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { candidate_id, opted_in, token } = req.body as z.infer<typeof ConsentBodySchema>;

      if (req.user) {
        if (!(STAFF_ROLES as readonly string[]).includes(req.user.role)) {
          res.status(403).json({ error: "Forbidden", detail: `Role '${req.user.role}' cannot record rediscovery consent` });
          return;
        }
        const consent = await setRediscoveryConsent(candidate_id, req.user.org_id, opted_in, req.user.user_id);
        res.status(200).json({ consent });
        return;
      }

      if (!token || !verifyConsentToken(candidate_id, token)) {
        res.status(404).json({ error: "Invalid or expired consent link" });
        return;
      }

      // Public path: derive org_id from the candidate record itself
      // (the token already proves the request is authorized for this
      // exact candidate_id).
      const candidateRes = await db.query<{ org_id: string }>(`SELECT org_id FROM candidates WHERE candidate_id=$1`, [
        candidate_id,
      ]);
      if (candidateRes.rowCount === 0) {
        res.status(404).json({ error: "Invalid or expired consent link" });
        return;
      }

      const consent = await setRediscoveryConsent(candidate_id, candidateRes.rows[0].org_id, opted_in, "CANDIDATE_SELF");
      res.status(200).json({ consent });
    } catch (err: any) {
      if (/not found/i.test(err?.message ?? "")) {
        res.status(404).json({ error: err.message });
        return;
      }
      next(err);
    }
  }
);

// ---------------------------------------------------------------------
// GET /api/v1/rediscovery/consent/:candidate_id
// ---------------------------------------------------------------------

/** Staff-only view of a candidate's current consent status, org-scoped. */
router.get(
  "/consent/:candidate_id",
  authenticate,
  rbac(...STAFF_READ_ROLES),
  validate({ params: CandidateIdParamSchema }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { candidate_id } = req.params as unknown as z.infer<typeof CandidateIdParamSchema>;
      const consent = await getRediscoveryConsent(candidate_id, req.user!.org_id);
      if (!consent) {
        res.status(200).json({ consent: null, status: "NO_RECORD" });
        return;
      }
      res.status(200).json({ consent, status: consent.opted_in ? "OPTED_IN" : "OPTED_OUT" });
    } catch (err) {
      next(err);
    }
  }
);

// ---------------------------------------------------------------------
// POST /api/v1/rediscovery/run
// ---------------------------------------------------------------------

/**
 * Runs the deterministic matching pass for a target circular/persona.
 * Only ever writes PENDING_REVIEW suggestions — see rediscovery_agent
 * header comment. Restricted to ADMIN/SENIOR_RECRUITER: this is a
 * batch operation over the entire org's rejected/withdrawn talent pool.
 */
router.post(
  "/run",
  authenticate,
  rbac(...RUN_ROLES),
  validate({ body: RunBodySchema }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = req.body as z.infer<typeof RunBodySchema>;
      // Through the generic runner (Agent-Level Hardening): timeout, retry
      // on transient failures, circuit breaker, structured log and audit
      // trail. The agent re-throws its own errors unchanged, so the
      // message-based status mapping below still works exactly as before.
      const result = await invoke(
        AGENT_NAMES.REDISCOVERY_RUN_MATCH,
        {
          org_id: req.user!.org_id,
          params: {
            target_circular_id: body.target_circular_id,
            target_position: body.target_position ?? null,
            persona_id: body.persona_id,
            min_fit_score: body.min_fit_score,
            min_days_since_decision: body.min_days_since_decision,
            require_opt_in: body.require_opt_in,
            max_candidates: body.max_candidates,
          },
          actor_user_id: req.user!.user_id,
        },
        {
          actor: req.user!.user_id,
          entity_type: "REDISCOVERY_RUN",
          entity_id: body.target_circular_id,
          request_id: req.requestId,
        }
      );
      res.status(200).json(result);
    } catch (err: any) {
      if (/not found/i.test(err?.message ?? "")) {
        res.status(404).json({ error: err.message });
        return;
      }
      if (/no requirements configured/i.test(err?.message ?? "")) {
        res.status(409).json({ error: err.message });
        return;
      }
      next(err);
    }
  }
);

// ---------------------------------------------------------------------
// GET /api/v1/rediscovery/suggestions
// ---------------------------------------------------------------------

router.get(
  "/suggestions",
  authenticate,
  rbac(...STAFF_READ_ROLES),
  validate({ query: SuggestionsQuerySchema }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const query = req.query as unknown as z.infer<typeof SuggestionsQuerySchema>;
      const result = await listRediscoverySuggestions(req.user!.org_id, query);
      res.status(200).json({ suggestions: result.suggestions, count: result.count, limit: query.limit, offset: query.offset });
    } catch (err) {
      next(err);
    }
  }
);

// ---------------------------------------------------------------------
// PATCH /api/v1/rediscovery/suggestions/:suggestion_id
// ---------------------------------------------------------------------

/** The only path by which a suggestion is ever finalized. Mandatory reason for both APPROVE and REJECT. */
router.patch(
  "/suggestions/:suggestion_id",
  authenticate,
  rbac(...STAFF_ROLES),
  validate({ params: SuggestionIdParamSchema, body: ReviewBodySchema }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { suggestion_id } = req.params as unknown as z.infer<typeof SuggestionIdParamSchema>;
      const { action, reason } = req.body as z.infer<typeof ReviewBodySchema>;
      const suggestion = await reviewSuggestion(suggestion_id, req.user!.org_id, req.user!.user_id, action, reason);
      res.status(200).json({ suggestion });
    } catch (err: any) {
      if (err instanceof RediscoveryReviewError) {
        res.status(409).json({ error: err.message });
        return;
      }
      if (/not found/i.test(err?.message ?? "")) {
        res.status(404).json({ error: err.message });
        return;
      }
      if (/mandatory/i.test(err?.message ?? "")) {
        res.status(400).json({ error: err.message });
        return;
      }
      next(err);
    }
  }
);

// ---------------------------------------------------------------------
// POST /api/v1/rediscovery/outreach
// ---------------------------------------------------------------------

/**
 * Sends re-engagement outreach for already-APPROVED suggestions via the
 * Communication Hub. Never auto-invites: this endpoint only acts on
 * suggestion_ids the caller explicitly lists, and only after a human
 * approved each one via the PATCH endpoint above. Per-suggestion
 * failures (wrong status, withdrawn consent, missing candidate) are
 * reported in `skipped` rather than failing the whole batch.
 */
router.post(
  "/outreach",
  authenticate,
  rbac(...STAFF_ROLES),
  validate({ body: OutreachBodySchema }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { suggestion_ids, channel, template_code } = req.body as z.infer<typeof OutreachBodySchema>;
      const result = await invoke(
        AGENT_NAMES.REDISCOVERY_SEND_OUTREACH,
        {
          suggestion_ids,
          channel,
          template_code,
          org_id: req.user!.org_id,
          actor_user_id: req.user!.user_id,
        },
        {
          actor: req.user!.user_id,
          entity_type: "REDISCOVERY_OUTREACH",
          entity_id: req.user!.org_id,
          request_id: req.requestId,
        }
      );
      res.status(200).json(result);
    } catch (err) {
      next(err);
    }
  }
);

// ---------------------------------------------------------------------
// GET /api/v1/rediscovery/outreach
// ---------------------------------------------------------------------

/** Additive beyond the literal spec: sent-outreach history for the UI ("sent outreach history" requirement). Org-scoped via join through rediscovery_suggestions. */
router.get(
  "/outreach",
  authenticate,
  rbac(...STAFF_READ_ROLES),
  validate({ query: OutreachQuerySchema }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const query = req.query as unknown as z.infer<typeof OutreachQuerySchema>;
      const result = await listRediscoveryOutreach(req.user!.org_id, query);
      res.status(200).json({ outreach: result.outreach, count: result.count, limit: query.limit, offset: query.offset });
    } catch (err) {
      next(err);
    }
  }
);

export default router;
