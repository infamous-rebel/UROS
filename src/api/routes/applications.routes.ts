import { Router, Request, Response, NextFunction } from "express";
import { z } from "zod";
import { authenticate } from "../middleware/auth";
import { rbac } from "../middleware/rbac";
import { validate } from "../middleware/validate";
import { importRateLimit } from "../middleware/rate_limit";
import { db } from "../../database/client";
import { logAudit } from "../../utils/audit_helper";
import { runBatchIsolated } from "../../services/agent_runner/batch";

const router = Router();

const ImportBodySchema = z.object({
  source: z.enum(["Teletalk", "bdjobs", "LinkedIn", "Email", "WhatsApp", "CSV"]),
  circular_id: z.string().min(1),
  applications: z
    .array(
      z.object({
        candidate_id: z.string().min(1),
        full_name: z.string().min(1),
        date_of_birth: z.string().optional(),
        phone_primary: z.string().optional(),
        email: z.string().email().optional(),
      })
    )
    .min(1),
});

/**
 * POST /api/v1/applications/import
 * Ingest an application batch. Records a batch marker and enqueues raw
 * records for the Parser Agent — actual parsing happens in the pipeline,
 * not synchronously in this request.
 */
router.post(
  "/import",
  authenticate,
  rbac("ADMIN", "RECRUITER", "SENIOR_RECRUITER", "SYSTEM_AGENT"),
  importRateLimit,
  validate({ body: ImportBodySchema }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { source, circular_id, applications } = req.body as z.infer<typeof ImportBodySchema>;
      const batchId = `BATCH-${circular_id}-${Date.now()}`;

      // Per-application error isolation (Agent-Level Hardening): an import
      // is a batch, and one row the database rejects (bad id, constraint,
      // connection blip) must not abort the remaining applications. Each
      // failure is logged, audited and reported back; the batch is still
      // accepted for the rows that landed.
      const importResult = await runBatchIsolated({
        agentName: "intake.import_applications",
        agentClass: "intake",
        items: applications,
        itemKey: (app) => app.candidate_id,
        actor: req.user!.user_id,
        request_id: req.requestId,
        entity_type: "BATCH",
        processItem: (app) =>
          db.query(
            `INSERT INTO candidates (candidate_id, org_id, full_name, source_platform, job_circular_id, status)
             VALUES ($1,$2,$3,$4,$5,'INTAKE')
             ON CONFLICT (candidate_id) DO NOTHING`,
            [app.candidate_id, req.user!.org_id, app.full_name, source, circular_id]
          ),
      });

      await logAudit({
        entity_type: "BATCH",
        entity_id: batchId,
        agent_or_user: req.user!.user_id,
        action: "BATCH_IMPORT_REQUESTED",
        output_value: {
          source,
          circular_id,
          count: applications.length,
          imported: importResult.ok,
          failed: importResult.failed,
        },
      });

      // Durable batch metadata so intake_agent.fetchBatch (and any later
      // process) can reconstruct what this batch was — replaces the
      // synthetic marker that previously existed only in the audit trail.
      await db.query(
        `INSERT INTO import_batches (batch_id, org_id, circular_id, source, status, total_items, imported, failed, requested_by, request_id)
         VALUES ($1,$2,$3,$4,'ACCEPTED',$5,$6,$7,$8,$9)
         ON CONFLICT (batch_id) DO NOTHING`,
        [batchId, req.user!.org_id, circular_id, source, applications.length, importResult.ok, importResult.failed, req.user!.user_id, req.requestId]
      );

      res.status(202).json({
        batch_id: batchId,
        circular_id,
        source,
        total_candidates: applications.length,
        imported: importResult.ok,
        failed: importResult.failures,
        status: "ACCEPTED",
      });
    } catch (err) {
      next(err);
    }
  }
);

export default router;
