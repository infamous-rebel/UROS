import { Router, Request, Response, NextFunction } from "express";
import { z } from "zod";
import { authenticate } from "../middleware/auth";
import { rbac } from "../middleware/rbac";
import { validate } from "../middleware/validate";
import { db } from "../../database/client";
import { logAudit } from "../../utils/audit_helper";
import { buildEffectiveChecks, DEFAULT_CHECK_CONFIGS } from "../../agents/fraud_detection_agent";
import { FRAUD_CHECK_TYPES, FraudCheck } from "../../models/fraud.model";
import { AGENT_NAMES, invoke } from "../../services/agent_runner/agents";

const router = Router();

const CheckTypeEnum = z.enum(FRAUD_CHECK_TYPES as [string, ...string[]]);
const ResolutionEnum = z.enum(["CONFIRMED", "FALSE_POSITIVE", "ESCALATED"]);

const STAFF_READ_ROLES = ["ADMIN", "RECRUITER", "SENIOR_RECRUITER", "AUDITOR", "DEPT_HEAD"] as const;

const ConfigureBodySchema = z.object({
  check_type: CheckTypeEnum,
  name: z.string().min(1).max(200),
  config: z.record(z.unknown()).default({}),
  active: z.boolean().default(true),
  is_knockout: z.boolean().default(false),
});

const RunBodySchema = z
  .object({
    candidate_ids: z.array(z.string().min(1)).max(500).optional(),
    circular_id: z.string().min(1).optional(),
  })
  .refine((d) => (d.candidate_ids && d.candidate_ids.length > 0) || !!d.circular_id, {
    message: "either candidate_ids (non-empty) or circular_id must be provided",
    path: ["candidate_ids"],
  });

const CandidateIdParamSchema = z.object({ candidate_id: z.string().min(1) });
const FlagIdParamSchema = z.object({ flag_id: z.string().uuid() });

const ResolveFlagBodySchema = z.object({
  resolution: ResolutionEnum,
  resolution_reason: z.string().min(1, "resolution_reason is mandatory"),
});

/**
 * POST /api/v1/fraud/configure
 * Creates (or replaces the active version of) one fraud check for the
 * caller's org. Mirrors the dimension_configs versioning pattern:
 * deactivates the prior active row for the same (org, check_type)
 * before inserting the new one, so exactly one active configuration per
 * check type exists at a time. A check_type with no configured row at
 * all continues to run using DEFAULT_CHECK_CONFIGS (see
 * fraud_detection_agent) — configuring here only overrides those
 * defaults, it does not "turn on" fraud detection, which is always on.
 */
router.post(
  "/configure",
  authenticate,
  rbac("ADMIN", "DEPT_HEAD"),
  validate({ body: ConfigureBodySchema }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { check_type, name, config, active, is_knockout } = req.body as z.infer<typeof ConfigureBodySchema>;
      const orgId = req.user!.org_id;

      const created = await db.withTransaction(async (client) => {
        await client.query(`UPDATE fraud_checks SET active=false WHERE org_id=$1 AND check_type=$2 AND active=true`, [
          orgId,
          check_type,
        ]);

        const insertRes = await client.query<FraudCheck>(
          `INSERT INTO fraud_checks (org_id, name, check_type, config, is_knockout, active, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7)
           RETURNING *`,
          [orgId, name, check_type, JSON.stringify(config), is_knockout, active, req.user!.user_id]
        );
        return insertRes.rows[0];
      });

      await logAudit({
        entity_type: "FRAUD_CHECK_CONFIG",
        entity_id: created.check_id,
        agent_or_user: req.user!.user_id,
        action: "FRAUD_CHECK_CONFIGURED",
        output_value: { check_type, name, active, is_knockout },
      });

      res.status(201).json({ fraud_check: created });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * GET /api/v1/fraud/checks
 * Lists the effective check set for the caller's org: every
 * FRAUD_CHECK_TYPE, using the org's active configuration where one
 * exists and DEFAULT_CHECK_CONFIGS otherwise (is_system_default=true),
 * so the UI never shows an empty list even before any org has
 * configured anything — fraud detection runs out of the box.
 */
router.get("/checks", authenticate, rbac(...STAFF_READ_ROLES), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const orgId = req.user!.org_id;
    const orgChecksRes = await db.query<FraudCheck>(`SELECT * FROM fraud_checks WHERE org_id=$1 ORDER BY created_at DESC`, [
      orgId,
    ]);
    const effective = buildEffectiveChecks(orgChecksRes.rows);

    const checks = effective.map((ec) => {
      const orgRow = orgChecksRes.rows.find((c) => c.check_id === ec.check_id);
      return {
        check_type: ec.check_type,
        check_id: ec.check_id,
        name: orgRow?.name ?? `${ec.check_type} (system default)`,
        config: ec.config,
        is_knockout: ec.is_knockout,
        active: true,
        is_system_default: ec.check_id === null,
      };
    });

    res.status(200).json({ checks, count: checks.length, all_check_types: FRAUD_CHECK_TYPES, default_configs: DEFAULT_CHECK_CONFIGS });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/v1/fraud/run
 * Runs fraud detection deterministically over either an explicit
 * candidate_ids list or every candidate under a circular_id (capped at
 * 500 per call — page through larger circulars with repeated calls;
 * mirrors the existing POST /evaluations/dimension-run batch-size
 * convention rather than introducing a new queue infrastructure for
 * this feature). Per-candidate error isolation: one bad candidate never
 * fails the batch. Every check outcome (including PASS) is audited
 * inside runFraudDetectionForCandidate; this handler additionally logs
 * the batch trigger itself.
 */
router.post(
  "/run",
  authenticate,
  rbac("ADMIN", "RECRUITER", "SENIOR_RECRUITER", "SYSTEM_AGENT"),
  validate({ body: RunBodySchema }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { candidate_ids, circular_id } = req.body as z.infer<typeof RunBodySchema>;
      const orgId = req.user!.org_id;

      let targetIds = candidate_ids ?? [];
      if (circular_id) {
        const circularRes = await db.query(
          `SELECT candidate_id FROM candidates WHERE org_id=$1 AND job_circular_id=$2 ORDER BY created_at ASC LIMIT 500`,
          [orgId, circular_id]
        );
        targetIds = Array.from(new Set([...targetIds, ...circularRes.rows.map((r: any) => r.candidate_id)]));
      }

      if (targetIds.length === 0) {
        res.status(200).json({ results: [], count: 0 });
        return;
      }

      // Invoked through the generic runner (Agent-Level Hardening): the
      // batch agent already isolates each candidate internally, and the
      // runner adds the timeout, transient-retry, circuit breaker, log and
      // audit trail around the whole run. Response shape is unchanged.
      const results = await invoke(
        AGENT_NAMES.FRAUD_DETECTION_BATCH,
        { candidate_ids: targetIds, org_id: orgId, actor_user_id: req.user!.user_id },
        {
          actor: req.user!.user_id,
          entity_type: "FRAUD_RUN",
          entity_id: orgId,
          request_id: req.requestId,
        }
      );

      await logAudit({
        entity_type: "FRAUD_RUN",
        entity_id: orgId,
        agent_or_user: req.user!.user_id,
        action: "FRAUD_RUN_TRIGGERED",
        input_value: { candidate_count: targetIds.length, circular_id: circular_id ?? null },
        output_value: {
          succeeded: results.filter((r) => !r.error).length,
          failed: results.filter((r) => r.error).length,
          total_flags: results.reduce((sum, r) => sum + r.flags_created.length, 0),
        },
      });

      res.status(200).json({ results, count: results.length });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * GET /api/v1/fraud/flags/:candidate_id
 * Full flag history for one candidate, most recent first — the
 * evidence panel is exactly the stored evidence JSON, nothing computed
 * client-side.
 */
router.get(
  "/flags/:candidate_id",
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

      const flagsRes = await db.query(
        `SELECT * FROM fraud_flags WHERE candidate_id=$1 AND org_id=$2 ORDER BY detected_at DESC`,
        [candidate_id, orgId]
      );

      res.status(200).json({ flags: flagsRes.rows, count: flagsRes.rowCount });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * PATCH /api/v1/fraud/flags/:flag_id
 * The only path by which a fraud flag is ever treated as resolved — the
 * agent only ever suggests. resolution_reason is mandatory regardless
 * of which resolution is chosen (confirm / false positive / escalate),
 * per the explicit requirement, not only for overrides.
 */
router.patch(
  "/flags/:flag_id",
  authenticate,
  rbac("ADMIN", "RECRUITER", "SENIOR_RECRUITER"),
  validate({ params: FlagIdParamSchema, body: ResolveFlagBodySchema }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { flag_id } = req.params as unknown as z.infer<typeof FlagIdParamSchema>;
      const { resolution, resolution_reason } = req.body as z.infer<typeof ResolveFlagBodySchema>;
      const orgId = req.user!.org_id;

      const existing = await db.query(`SELECT * FROM fraud_flags WHERE flag_id=$1 AND org_id=$2`, [flag_id, orgId]);
      if (existing.rowCount === 0) {
        res.status(404).json({ error: "Fraud flag not found" });
        return;
      }

      const updated = await db.query(
        `UPDATE fraud_flags
         SET status=$1, resolution=$2, resolution_reason=$3, reviewed_by=$4, reviewed_at=now()
         WHERE flag_id=$5
         RETURNING *`,
        [resolution, resolution, resolution_reason, req.user!.user_id, flag_id]
      );

      await logAudit({
        entity_type: "FRAUD_FLAG",
        entity_id: flag_id,
        agent_or_user: req.user!.user_id,
        action: `FRAUD_FLAG_${resolution}`,
        input_value: { previous_status: existing.rows[0].status, check_type: existing.rows[0].check_type },
        output_value: { resolution },
        reason_comment: resolution_reason,
      });

      res.status(200).json({ flag: updated.rows[0] });
    } catch (err) {
      next(err);
    }
  }
);

export default router;
