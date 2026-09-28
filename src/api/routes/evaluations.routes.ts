import { Router, Request, Response, NextFunction } from "express";
import { z } from "zod";
import { authenticate } from "../middleware/auth";
import { rbac } from "../middleware/rbac";
import { validate } from "../middleware/validate";
import { db } from "../../database/client";
import { logAudit } from "../../utils/audit_helper";
import { enqueueEvaluationJob, getJobStatus } from "../../services/queue/producer";
import { AGENT_NAMES, invoke } from "../../services/agent_runner/agents";

const router = Router();

const DimensionRunBodySchema = z.object({
  candidate_ids: z.array(z.string().min(1)).min(1).max(500),
  persona_id: z.string().uuid().optional(),
});

const RunBodySchema = z.object({
  batch_id: z.string().min(1),
  circular_id: z.string().min(1),
  rule_pack_version_id: z.string().uuid(),
  stage: z.enum(["ELIGIBILITY", "SCORING", "BOTH"]).default("BOTH"),
});

const BatchIdParamSchema = z.object({ batchId: z.string().min(1) });
const JobIdParamSchema = z.object({ jobId: z.string().uuid() });

/**
 * POST /api/v1/evaluations/run
 * Enqueues eligibility and/or scoring evaluation for a circular/batch
 * against a specific rule pack version. Processing happens asynchronously
 * via the queue (BullMQ if REDIS_URL is configured, else a Postgres-backed
 * worker — see services/queue). Idempotent: a duplicate submission for the
 * same (circular, rule_pack_version, stage) while a job is still active
 * returns the existing job instead of enqueueing a second one.
 */
router.post(
  "/run",
  authenticate,
  rbac("ADMIN", "RECRUITER", "SENIOR_RECRUITER", "SYSTEM_AGENT"),
  validate({ body: RunBodySchema }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { batch_id, circular_id, rule_pack_version_id, stage } = req.body as z.infer<typeof RunBodySchema>;

      const { job, deduplicated } = await enqueueEvaluationJob({
        batch_id,
        circular_id,
        rule_pack_version_id,
        org_id: req.user!.org_id,
        stage,
        requested_by: req.user!.user_id,
      });

      res.status(202).json({
        job_id: job.job_id,
        status: job.status,
        stage: job.stage,
        deduplicated,
      });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * POST /api/v1/evaluations/dimension-run
 * Runs the 7-Dimension scoring agent synchronously for a small candidate
 * list/batch against the caller's org's active dimension configuration
 * (optionally scoped by persona_id). Deterministic and per-candidate:
 * one candidate's missing config/data never blocks the rest of the
 * batch — failures are reported individually. Every successful run is
 * already audited inside runDimensionScoring; this handler additionally
 * logs the batch trigger itself for traceability.
 */
router.post(
  "/dimension-run",
  authenticate,
  rbac("ADMIN", "SENIOR_RECRUITER"),
  validate({ body: DimensionRunBodySchema }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { candidate_ids, persona_id } = req.body as z.infer<typeof DimensionRunBodySchema>;
      const orgId = req.user!.org_id;

      const results: Array<{ candidate_id: string; evaluation_id?: string; overall_fit_score?: number; recommended_decision?: string; error?: string }> = [];

      for (const candidateId of candidate_ids) {
        // Per-candidate error isolation (Agent-Level Hardening): one
        // candidate that cannot be scored is recorded with its reason and
        // the loop continues, so a batch request never loses the other
        // candidates' results. The scoring call itself goes through the
        // runner, which adds timeout / retry / circuit / audit around it.
        try {
          const outcome = await invoke(
            AGENT_NAMES.DIMENSION_SCORING_RUN,
            {
              candidate_id: candidateId,
              org_id: orgId,
              persona_id: persona_id ?? null,
              actor_user_id: req.user!.user_id,
            },
            {
              actor: req.user!.user_id,
              entity_type: "CANDIDATE",
              entity_id: candidateId,
              request_id: req.requestId,
            }
          );
          results.push({
            candidate_id: candidateId,
            evaluation_id: outcome.evaluation_id,
            overall_fit_score: outcome.overall_fit_score,
            recommended_decision: outcome.recommended_decision,
          });
        } catch (err) {
          results.push({ candidate_id: candidateId, error: err instanceof Error ? err.message : String(err) });
        }
      }

      await logAudit({
        entity_type: "DIMENSION_RUN",
        entity_id: orgId,
        agent_or_user: req.user!.user_id,
        action: "DIMENSION_RUN_TRIGGERED",
        input_value: { candidate_count: candidate_ids.length, persona_id: persona_id ?? null },
        output_value: {
          succeeded: results.filter((r) => !r.error).length,
          failed: results.filter((r) => r.error).length,
        },
      });

      res.status(200).json({ results, count: results.length });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * GET /api/v1/evaluations/jobs/:jobId
 * Poll the status of a submitted evaluation job.
 */
router.get(
  "/jobs/:jobId",
  authenticate,
  rbac("ADMIN", "RECRUITER", "SENIOR_RECRUITER", "AUDITOR", "SYSTEM_AGENT"),
  validate({ params: JobIdParamSchema }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { jobId } = req.params as unknown as z.infer<typeof JobIdParamSchema>;
      const job = await getJobStatus(jobId);
      // Security Hardening Round: getJobStatus does not filter by org —
      // enforce it here so a job belonging to another org 404s exactly
      // like a nonexistent one, rather than leaking its batch/circular
      // details, rule pack version, and error message cross-tenant.
      if (!job || job.org_id !== req.user!.org_id) {
        res.status(404).json({ error: "Job not found" });
        return;
      }
      res.status(200).json({ job });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * GET /api/v1/evaluations/:batchId
 * Summary of evaluation outcomes for all candidates in a circular/batch.
 */
router.get(
  "/:batchId",
  authenticate,
  rbac("ADMIN", "RECRUITER", "SENIOR_RECRUITER", "AUDITOR"),
  validate({ params: BatchIdParamSchema }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { batchId } = req.params as unknown as z.infer<typeof BatchIdParamSchema>;
      const orgId = req.user!.org_id;

      // batchId convention: BATCH-{circular_id}-{timestamp}; extract circular_id
      const circularId = batchId.startsWith("BATCH-") ? batchId.split("-").slice(1, -1).join("-") : batchId;

      // Security Hardening Round: previously joined only on
      // c.job_circular_id with no org filter — any authenticated user
      // could view any org's evaluation summary by guessing/knowing a
      // circular_id (these follow a public, often-guessable naming
      // convention, e.g. "BSC-2026-05"). c.org_id=$2 closes that.
      const summary = await db.query(
        `SELECT er.status, COUNT(*) AS count
         FROM evaluation_results er
         JOIN candidates c ON c.candidate_id = er.candidate_id
         WHERE c.job_circular_id = $1 AND c.org_id = $2
         GROUP BY er.status`,
        [circularId, orgId]
      );

      const reasonBreakdown = await db.query(
        `SELECT er.reason_code, COUNT(*) AS count
         FROM evaluation_results er
         JOIN candidates c ON c.candidate_id = er.candidate_id
         WHERE c.job_circular_id = $1 AND c.org_id = $2
         GROUP BY er.reason_code
         ORDER BY count DESC`,
        [circularId, orgId]
      );

      res.status(200).json({
        batch_id: batchId,
        circular_id: circularId,
        status_summary: summary.rows,
        reason_code_breakdown: reasonBreakdown.rows,
      });
    } catch (err) {
      next(err);
    }
  }
);

export default router;
