import { Router, Request, Response, NextFunction } from "express";
import { z } from "zod";
import { authenticate } from "../middleware/auth";
import { rbac } from "../middleware/rbac";
import { validate } from "../middleware/validate";
import { candidateQueryRateLimit } from "../middleware/rate_limit";
import { db } from "../../database/client";
import { logAudit } from "../../utils/audit_helper";
import AdmZip from "adm-zip";
import fs from "fs";
import path from "path";

const router = Router();

const CandidateStatusEnum = z.enum([
  "INTAKE", "PARSED", "ELIGIBILITY_DONE", "SCORED", "NEEDS_REVIEW",
  "ELIGIBLE_APPROVED", "SHORTLISTED", "VERIFIED", "REJECTED", "SELECTED", "WITHDRAWN",
]);

const CandidateStatusTransitionEnum = z.enum([
  "INTAKE", "PARSED", "ELIGIBILITY_DONE", "ELIGIBLE_APPROVED", "SCORED",
  "NEEDS_REVIEW", "SHORTLISTED", "VERIFIED", "REJECTED", "SELECTED", "WITHDRAWN",
]);

const ListQuerySchema = z.object({
  status: CandidateStatusEnum.optional(),
  circular_id: z.string().optional(),
  search: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

const IdParamSchema = z.object({ id: z.string().min(1) });

const DimensionScoreIdParamSchema = z.object({
  id: z.string().min(1),
  evaluation_id: z.string().uuid(),
});

const DimensionScoreDecisionSchema = z
  .object({
    decision: z.enum(["APPROVE", "REJECT", "OVERRIDE"]),
    override_reason: z.string().optional(),
  })
  .refine((d) => d.decision !== "OVERRIDE" || (!!d.override_reason && d.override_reason.trim().length > 0), {
    message: "override_reason is mandatory when decision is OVERRIDE",
    path: ["override_reason"],
  });

const PatchBodySchema = z
  .object({
    full_name: z.string().min(1).optional(),
    phone_primary: z.string().optional(),
    email: z.string().email().optional(),
    present_address: z.string().optional(),
    permanent_address: z.string().optional(),
    district: z.string().optional(),
    division: z.string().optional(),
    preferred_language: z.enum(["en", "bn"]).optional(),
    correction_reason: z.string().min(1, "correction_reason is mandatory for a human data correction"),
  })
  .refine((data) => Object.keys(data).length > 1, {
    message: "At least one field besides correction_reason must be provided",
  });

/**
 * GET /api/v1/candidates
 * List candidates with filters: status, circular_id, free-text search on name/id.
 */
router.get(
  "/",
  authenticate,
  candidateQueryRateLimit,
  validate({ query: ListQuerySchema }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { status, circular_id, search, limit, offset } = req.query as unknown as z.infer<typeof ListQuerySchema>;

      const conditions: string[] = ["org_id = $1"];
      const params: unknown[] = [req.user!.org_id];

      if (status) {
        params.push(status);
        conditions.push(`status = $${params.length}`);
      }
      if (circular_id) {
        params.push(circular_id);
        conditions.push(`job_circular_id = $${params.length}`);
      }
      if (search) {
        params.push(`%${search}%`);
        conditions.push(`(full_name ILIKE $${params.length} OR candidate_id ILIKE $${params.length})`);
      }

      params.push(limit);
      params.push(offset);

      // For NEEDS_REVIEW candidates, join with evaluation_results to surface
      // reason codes and evidence snippets for the DecisionQueue (Quest 05 Part 3).
      const joinEval = status === "NEEDS_REVIEW";
      const result = await db.query(
        `SELECT c.candidate_id, c.full_name, c.status, c.source_platform, c.job_circular_id,
                c.position_applied, c.data_confidence, c.created_at, c.updated_at${
                  joinEval
                    ? `, e.reason_code, e.confidence AS eval_confidence,
                       e.distance_to_threshold, e.input_value`
                    : ""
                }
         FROM candidates c${
           joinEval
             ? ` LEFT JOIN LATERAL (
                  SELECT reason_code, confidence, distance_to_threshold, input_value
                  FROM evaluation_results
                  WHERE candidate_id = c.candidate_id AND org_id = $1
                  ORDER BY evaluated_at DESC LIMIT 1
                ) e ON true`
             : ""
         }
         WHERE ${conditions.join(" AND ")}
         ORDER BY c.created_at DESC
         LIMIT $${params.length - 1} OFFSET $${params.length}`,
        params
      );

      res.status(200).json({
        candidates: result.rows,
        limit,
        offset,
        count: result.rowCount,
      });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * GET /api/v1/candidates/:id
 * Full candidate profile: core record + academic + documents + evaluation summary.
 */
router.get(
  "/:id",
  authenticate,
  candidateQueryRateLimit,
  validate({ params: IdParamSchema }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = req.params as unknown as z.infer<typeof IdParamSchema>;

      const candidateRes = await db.query(
        `SELECT * FROM candidates WHERE candidate_id=$1 AND org_id=$2`,
        [id, req.user!.org_id]
      );
      if (candidateRes.rowCount === 0) {
        res.status(404).json({ error: "Candidate not found" });
        return;
      }

      const [academic, documents, evaluations, scoring, verifications] = await Promise.all([
        db.query(`SELECT * FROM candidate_academic_records WHERE candidate_id=$1`, [id]),
        db.query(`SELECT * FROM candidate_documents WHERE candidate_id=$1`, [id]),
        db.query(
          `SELECT rule_id, status, reason_code, confidence, distance_to_threshold,
                  human_decision, evaluated_at, input_value
           FROM evaluation_results WHERE candidate_id=$1 AND org_id=$2 ORDER BY evaluated_at DESC`,
          [id, req.user!.org_id]
        ),
        db.query(
          `SELECT total_score, breakdown, rank, computed_at
           FROM scoring_results WHERE candidate_id=$1 AND org_id=$2 ORDER BY computed_at DESC LIMIT 1`,
          [id, req.user!.org_id]
        ),
        db.query(
          `SELECT verification_id, source, status, details, checked_at, signed_off_by, signed_off_at
           FROM verification_results WHERE candidate_id=$1 AND org_id=$2 ORDER BY checked_at DESC`,
          [id, req.user!.org_id]
        ),
      ]);

      res.status(200).json({
        candidate: candidateRes.rows[0],
        academic_records: academic.rows,
        documents: documents.rows,
        evaluation_summary: evaluations.rows,
        scoring: scoring.rows[0] ?? null,
        verification_results: verifications.rows,
      });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * PATCH /api/v1/candidates/:id
 * Human correction of extracted candidate data. Mandatory reason, fully audited.
 */
router.patch(
  "/:id",
  authenticate,
  rbac("RECRUITER", "SENIOR_RECRUITER", "ADMIN"),
  validate({ params: IdParamSchema, body: PatchBodySchema }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = req.params as unknown as z.infer<typeof IdParamSchema>;
      const { correction_reason, ...fields } = req.body as z.infer<typeof PatchBodySchema>;

      const existing = await db.query(`SELECT * FROM candidates WHERE candidate_id=$1 AND org_id=$2`, [
        id,
        req.user!.org_id,
      ]);
      if (existing.rowCount === 0) {
        res.status(404).json({ error: "Candidate not found" });
        return;
      }

      const setClauses: string[] = [];
      const params: unknown[] = [];
      for (const [key, value] of Object.entries(fields)) {
        params.push(value);
        setClauses.push(`${key} = $${params.length}`);
      }
      params.push(id);

      await db.query(
        `UPDATE candidates SET ${setClauses.join(", ")}, updated_at=now() WHERE candidate_id=$${params.length}`,
        params
      );

      await logAudit({
        org_id: req.user!.org_id,
        entity_type: "CANDIDATE",
        entity_id: id,
        agent_or_user: req.user!.user_id,
        action: "CANDIDATE_CORRECTED",
        input_value: existing.rows[0],
        output_value: fields,
        reason_comment: correction_reason,
      });

      const updated = await db.query(`SELECT * FROM candidates WHERE candidate_id=$1`, [id]);
      res.status(200).json({ candidate: updated.rows[0] });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * PATCH /api/v1/candidates/:id/status
 * Human-in-the-loop status transition (e.g. -> ELIGIBLE_APPROVED).
 * Mandatory correction_reason, fully audit-logged. RBAC: RECRUITER+.
 */
const StatusTransitionBodySchema = z.object({
  status: CandidateStatusTransitionEnum,
  correction_reason: z.string().min(1, "correction_reason is mandatory for status transitions"),
});

router.patch(
  "/:id/status",
  authenticate,
  rbac("RECRUITER", "SENIOR_RECRUITER", "ADMIN"),
  validate({ params: IdParamSchema, body: StatusTransitionBodySchema }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = req.params as unknown as z.infer<typeof IdParamSchema>;
      const { status, correction_reason } = req.body as z.infer<typeof StatusTransitionBodySchema>;

      const existing = await db.query(
        `SELECT candidate_id, status FROM candidates WHERE candidate_id=$1 AND org_id=$2`,
        [id, req.user!.org_id]
      );
      if (existing.rowCount === 0) {
        res.status(404).json({ error: "Candidate not found" });
        return;
      }
      const previousStatus = existing.rows[0].status;

      await db.query(
        `UPDATE candidates SET status=$1, updated_at=now() WHERE candidate_id=$2`,
        [status, id]
      );

      await logAudit({
        org_id: req.user!.org_id,
        entity_type: "CANDIDATE",
        entity_id: id,
        agent_or_user: req.user!.user_id,
        action: "CANDIDATE_STATUS_CHANGED",
        input_value: { previous_status: previousStatus, new_status: status },
        output_value: { candidate_id: id, status },
        reason_comment: correction_reason,
      });

      const updated = await db.query(`SELECT * FROM candidates WHERE candidate_id=$1`, [id]);
      res.status(200).json({ candidate: updated.rows[0] });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * GET /api/v1/candidates/:id/dimension-scores
 * Full history of 7-Dimension scoring runs for a candidate, most recent
 * first. Each row carries the full dimension_breakdown evidence — the
 * evidence panel is exactly this JSON, nothing extra computed client-side.
 */
router.get(
  "/:id/dimension-scores",
  authenticate,
  candidateQueryRateLimit,
  validate({ params: IdParamSchema }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = req.params as unknown as z.infer<typeof IdParamSchema>;

      const candidateRes = await db.query(`SELECT candidate_id FROM candidates WHERE candidate_id=$1 AND org_id=$2`, [
        id,
        req.user!.org_id,
      ]);
      if (candidateRes.rowCount === 0) {
        res.status(404).json({ error: "Candidate not found" });
        return;
      }

      const result = await db.query(
        `SELECT * FROM candidate_dimension_scores WHERE candidate_id=$1 ORDER BY computed_at DESC`,
        [id]
      );

      res.status(200).json({ dimension_scores: result.rows, count: result.rowCount });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * PATCH /api/v1/candidates/:id/dimension-scores/:evaluation_id
 * Human-in-the-loop resolution of a dimension scoring run: approve the
 * system's overall_fit_score/recommended_decision as-is, reject it, or
 * override with a mandatory reason. This is the only way a dimension
 * score result is ever treated as final anywhere downstream — the agent
 * only ever suggests.
 */
router.patch(
  "/:id/dimension-scores/:evaluation_id",
  authenticate,
  rbac("RECRUITER", "SENIOR_RECRUITER"),
  validate({ params: DimensionScoreIdParamSchema, body: DimensionScoreDecisionSchema }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id, evaluation_id } = req.params as unknown as z.infer<typeof DimensionScoreIdParamSchema>;
      const { decision, override_reason } = req.body as z.infer<typeof DimensionScoreDecisionSchema>;

      const existing = await db.query(
        `SELECT * FROM candidate_dimension_scores WHERE evaluation_id=$1 AND candidate_id=$2 AND org_id=$3`,
        [evaluation_id, id, req.user!.org_id]
      );
      if (existing.rowCount === 0) {
        res.status(404).json({ error: "Dimension score evaluation not found" });
        return;
      }

      const statusMap: Record<typeof decision, string> = {
        APPROVE: "APPROVED",
        REJECT: "REJECTED",
        OVERRIDE: "OVERRIDDEN",
      };

      const updated = await db.query(
        `UPDATE candidate_dimension_scores
         SET status=$1, human_reviewer=$2, human_decision=$3, override_reason=$4, reviewed_at=now()
         WHERE evaluation_id=$5
         RETURNING *`,
        [statusMap[decision], req.user!.user_id, decision, override_reason ?? null, evaluation_id]
      );

      await logAudit({
        org_id: req.user!.org_id,
        entity_type: "DIMENSION_SCORE",
        entity_id: evaluation_id,
        agent_or_user: req.user!.user_id,
        action: `DIMENSION_SCORE_${statusMap[decision]}`,
        input_value: { recommended_decision: existing.rows[0].recommended_decision, overall_fit_score: existing.rows[0].overall_fit_score },
        output_value: { decision, status: statusMap[decision] },
        reason_comment: override_reason ?? undefined,
      });

      res.status(200).json({ dimension_score: updated.rows[0] });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * POST /api/v1/candidates/:id/notes
 * Add a human note to a candidate record. Audited as CANDIDATE_NOTE_ADDED.
 * RBAC: RECRUITER+.
 */
const NoteBodySchema = z.object({
  note: z.string().min(1, "note is required"),
});

router.post(
  "/:id/notes",
  authenticate,
  rbac("RECRUITER", "SENIOR_RECRUITER", "ADMIN"),
  validate({ params: IdParamSchema, body: NoteBodySchema }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = req.params as unknown as z.infer<typeof IdParamSchema>;
      const { note } = req.body as z.infer<typeof NoteBodySchema>;

      const existing = await db.query(
        `SELECT candidate_id FROM candidates WHERE candidate_id=$1 AND org_id=$2`,
        [id, req.user!.org_id]
      );
      if (existing.rowCount === 0) {
        res.status(404).json({ error: "Candidate not found" });
        return;
      }

      await logAudit({
        org_id: req.user!.org_id,
        entity_type: "CANDIDATE",
        entity_id: id,
        agent_or_user: req.user!.user_id,
        action: "CANDIDATE_NOTE_ADDED",
        reason_comment: note,
      });

      res.status(201).json({ ok: true, note, candidate_id: id });
    } catch (err) {
      next(err);
    }
  }
);

// ─── Quest 05 Part 8: Candidate Export Endpoints ────────────────────

/**
 * GET /api/v1/candidates/:id/export
 * Export a single candidate profile as PDF (placeholder) or CSV.
 */
router.get(
  "/:id/export",
  authenticate,
  rbac("ADMIN", "SENIOR_RECRUITER", "RECRUITER", "AUDITOR"),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const format = (req.query.format as string) ?? "pdf";
      const candidate = await db.query(
        `SELECT * FROM candidates WHERE candidate_id = $1 AND org_id = $2`,
        [req.params.id, req.user!.org_id]
      );
      if (candidate.rowCount === 0) {
        res.status(404).json({ error: "Candidate not found" });
        return;
      }

      const c = candidate.rows[0];
      const filename = `candidate-${c.full_name?.replace(/\s+/g, "-") ?? c.candidate_id}.${format}`;

      await logAudit({
        org_id: req.user!.org_id,
        entity_type: "CANDIDATE",
        entity_id: req.params.id,
        agent_or_user: req.user!.user_id,
        action: "FILE_DOWNLOADED",
        output_value: { format, resource: "candidate_profile", filename },
      });

      if (format === "csv") {
        const csv = `candidate_id,full_name,email,status,source_platform,created_at\n${c.candidate_id},${c.full_name ?? ""},${c.email ?? ""},${c.status ?? ""},${c.source_platform ?? ""},${c.created_at ?? ""}`;
        res.setHeader("Content-Type", "text/csv");
        res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
        res.send(csv);
      } else {
        const content = `%PDF-1.4\n% Candidate Profile: ${c.full_name ?? "Unknown"}\n% ID: ${c.candidate_id}\n% Status: ${c.status ?? "N/A"}\n% Source: ${c.source_platform ?? "N/A"}\n% Generated: ${new Date().toISOString()}\n`;
        res.setHeader("Content-Type", "application/pdf");
        res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
        res.send(content);
      }
    } catch (err) { next(err); }
  }
);

/**
 * GET /api/v1/candidates/:id/documents.zip
 * ZIP of all uploaded documents for a candidate.
 */
router.get(
  "/:id/documents.zip",
  authenticate,
  rbac("ADMIN", "SENIOR_RECRUITER", "RECRUITER"),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const candidate = await db.query(
        `SELECT full_name FROM candidates WHERE candidate_id = $1 AND org_id = $2`,
        [req.params.id, req.user!.org_id]
      );
      if (candidate.rowCount === 0) {
        res.status(404).json({ error: "Candidate not found" });
        return;
      }

      const name = candidate.rows[0].full_name?.replace(/\s+/g, "-") ?? req.params.id;
      const filename = `${name}-documents.zip`;

      await logAudit({
        org_id: req.user!.org_id,
        entity_type: "CANDIDATE",
        entity_id: req.params.id,
        agent_or_user: req.user!.user_id,
        action: "FILE_DOWNLOADED",
        output_value: { format: "zip", resource: "candidate_documents", filename },
      });

      // Query candidate_documents
      const docs = await db.query(
        `SELECT doc_id, doc_type, file_location FROM candidate_documents WHERE candidate_id = $1`,
        [req.params.id]
      );

      if (docs.rowCount === 0) {
        res.status(404).json({ error: "No documents to download" });
        return;
      }

      // Build real ZIP from actual files
      const zip = new AdmZip();
      for (const doc of docs.rows) {
        const filePath = doc.file_location;
        if (fs.existsSync(filePath)) {
          const ext = path.extname(filePath) || ".bin";
          const fileName = `${doc.doc_type}-${doc.doc_id}${ext}`;
          zip.addLocalFile(filePath, "", fileName);
        }
      }

      const zipBuffer = zip.toBuffer();
      res.setHeader("Content-Type", "application/zip");
      res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
      res.send(zipBuffer);
    } catch (err) { next(err); }
  }
);

/**
 * POST /api/v1/candidates/export-bulk
 * Bulk export of multiple candidates as CSV or JSON.
 */
router.post(
  "/export-bulk",
  authenticate,
  rbac("ADMIN", "SENIOR_RECRUITER", "RECRUITER"),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { candidate_ids, format = "csv" } = req.body as { candidate_ids: string[]; format?: string };
      if (!candidate_ids?.length) {
        res.status(400).json({ error: "No candidate IDs provided" });
        return;
      }

      const candidates = await db.query(
        `SELECT candidate_id, full_name, email, status, source_platform, created_at
         FROM candidates WHERE candidate_id = ANY($1) AND org_id = $2`,
        [candidate_ids, req.user!.org_id]
      );

      await logAudit({
        org_id: req.user!.org_id,
        entity_type: "CANDIDATE",
        entity_id: `bulk-${candidate_ids.length}`,
        agent_or_user: req.user!.user_id,
        action: "FILE_DOWNLOADED",
        output_value: { format, resource: "bulk_candidate_export", count: candidates.rowCount },
      });

      if (format === "csv") {
        const header = "candidate_id,full_name,email,status,source_platform,created_at";
        const rows = candidates.rows.map((c) =>
          `${c.candidate_id},"${c.full_name ?? ""}","${c.email ?? ""}",${c.status ?? ""},${c.source_platform ?? ""},${c.created_at ?? ""}`
        );
        const csv = [header, ...rows].join("\n");
        res.setHeader("Content-Type", "text/csv");
        res.setHeader("Content-Disposition", `attachment; filename="candidates-export.csv"`);
        res.send(csv);
      } else {
        res.setHeader("Content-Type", "application/json");
        res.setHeader("Content-Disposition", `attachment; filename="candidates-export.json"`);
        res.json({ candidates: candidates.rows, count: candidates.rowCount });
      }
    } catch (err) { next(err); }
  }
);

export default router;
