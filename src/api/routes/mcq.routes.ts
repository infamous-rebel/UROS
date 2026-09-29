import { Router, Request, Response, NextFunction } from "express";
import multer from "multer";
import { z } from "zod";
import path from "path";
import fs from "fs";
import { authenticate } from "../middleware/auth";
import { rbac } from "../middleware/rbac";
import { validate } from "../middleware/validate";
import { importRateLimit } from "../middleware/rate_limit";
import { FileValidationError } from "../../utils/errors";
import { db } from "../../database/client";
import { logAudit } from "../../utils/audit_helper";
import { expandUpload, scoreSheet } from "../../agents/exam_scanner_agent";
import { McqOption } from "../../models/mcq.model";
import { AGENT_NAMES, invoke } from "../../services/agent_runner/agents";
import { runBatchIsolated } from "../../services/agent_runner/batch";

const router = Router();

// Security Hardening Round: fileFilter added — previously only a size
// limit was enforced, so multer would buffer (and downstream code would
// attempt to parse) any content-type. Matches exactly what
// expandUpload()/ingestSheetFile() actually handle: scanned page
// images, PDFs, and ZIP batches of the two. Rejecting outside this set
// at the multer layer means a bad file never reaches the parsing agent
// at all.
const MCQ_ALLOWED_MIME_TYPES = new Set([
  "application/pdf",
  "image/jpeg",
  "image/png",
  "application/zip",
  "application/x-zip-compressed",
  "application/octet-stream", // some browsers send this for .zip; extension is still checked below
]);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB — covers a batch ZIP of scanned pages
  fileFilter: (_req, file, cb) => {
    const lowerName = file.originalname.toLowerCase();
    const hasAllowedExtension = /\.(pdf|jpe?g|png|zip)$/.test(lowerName);
    if (MCQ_ALLOWED_MIME_TYPES.has(file.mimetype) && hasAllowedExtension) {
      cb(null, true);
      return;
    }
    cb(new FileValidationError(`Unsupported file type: ${file.mimetype || "unknown"} (${file.originalname}). Only PDF, JPEG, PNG, or ZIP are accepted.`));
  },
});

const OptionEnum = z.enum(["A", "B", "C", "D", "E"]);

// ---------------------------------------------------------------------
// POST /api/v1/mcq/configure
// ---------------------------------------------------------------------

const ZoneSchema = z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1), width: z.number().min(0).max(1), height: z.number().min(0).max(1) });

const AnswerSheetTemplateSchema = z.object({
  roll_zone: z.object({
    digit_count: z.number().int().min(1).max(20),
    digit_columns: z.array(ZoneSchema).min(1),
    digit_option_height: z.number().min(0).max(1),
  }),
  question_zones: z.array(
    z.object({
      question_no: z.number().int().min(1),
      options: z.array(z.object({ option: OptionEnum, x: z.number(), y: z.number(), width: z.number(), height: z.number() })).min(2),
    })
  ),
});

const ConfigureBodySchema = z.object({
  exam_id: z.string().uuid().optional(), // omit to create a new exam
  name: z.string().min(1),
  date: z.string().optional(),
  total_questions: z.number().int().min(1),
  marks_per_question: z.number().min(0).default(1),
  negative_mark: z.number().min(0).default(0),
  pass_threshold: z.number().optional(),
  answer_sheet_template: AnswerSheetTemplateSchema,
  answer_key: z.array(z.object({ question_no: z.number().int().min(1), correct_option: OptionEnum })).min(1),
});

/**
 * POST /api/v1/mcq/configure
 * Creates a new exam (or updates one owned by the caller's org, keyed by
 * exam_id) and publishes a new active answer key version. Prior key
 * versions are deactivated, never mutated — mirrors dimension/rule pack
 * versioning elsewhere in UROS.
 */
router.post(
  "/configure",
  authenticate,
  rbac("ADMIN", "DEPT_HEAD"),
  validate({ body: ConfigureBodySchema }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = req.body as z.infer<typeof ConfigureBodySchema>;
      const orgId = req.user!.org_id;

      if (body.answer_key.length > body.total_questions) {
        res.status(400).json({ error: "answer_key has more entries than total_questions" });
        return;
      }

      const result = await db.withTransaction(async (client) => {
        let examId = body.exam_id;

        if (examId) {
          const existing = await client.query(`SELECT exam_id FROM mcq_exams WHERE exam_id=$1 AND org_id=$2`, [examId, orgId]);
          if (existing.rowCount === 0) {
            throw Object.assign(new Error("Exam not found in this org"), { statusCode: 404 });
          }
          await client.query(
            `UPDATE mcq_exams SET name=$1, date=$2, total_questions=$3, marks_per_question=$4, negative_mark=$5,
               pass_threshold=$6, answer_sheet_template=$7
             WHERE exam_id=$8`,
            [
              body.name,
              body.date ?? null,
              body.total_questions,
              body.marks_per_question,
              body.negative_mark,
              body.pass_threshold ?? null,
              JSON.stringify(body.answer_sheet_template),
              examId,
            ]
          );
          await client.query(`UPDATE mcq_answer_keys SET active=false WHERE exam_id=$1 AND active=true`, [examId]);
        } else {
          const insertRes = await client.query(
            `INSERT INTO mcq_exams (org_id, name, date, total_questions, marks_per_question, negative_mark, pass_threshold, answer_sheet_template, created_by)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING exam_id`,
            [
              orgId,
              body.name,
              body.date ?? null,
              body.total_questions,
              body.marks_per_question,
              body.negative_mark,
              body.pass_threshold ?? null,
              JSON.stringify(body.answer_sheet_template),
              req.user!.user_id,
            ]
          );
          examId = insertRes.rows[0].exam_id;
        }

        const versionRes = await client.query(
          `SELECT COALESCE(MAX(version), 0) + 1 AS next_version FROM mcq_answer_keys WHERE exam_id=$1`,
          [examId]
        );
        const nextVersion = versionRes.rows[0].next_version as number;

        for (const entry of body.answer_key) {
          await client.query(
            `INSERT INTO mcq_answer_keys (exam_id, question_no, correct_option, version, active) VALUES ($1,$2,$3,$4,true)`,
            [examId, entry.question_no, entry.correct_option, nextVersion]
          );
        }

        const examRes = await client.query(`SELECT * FROM mcq_exams WHERE exam_id=$1`, [examId]);
        return examRes.rows[0];
      });

      await logAudit({
        entity_type: "MCQ_EXAM",
        entity_id: result.exam_id,
        agent_or_user: req.user!.user_id,
        action: body.exam_id ? "MCQ_EXAM_RECONFIGURED" : "MCQ_EXAM_CREATED",
        output_value: { name: body.name, total_questions: body.total_questions, answer_key_count: body.answer_key.length },
      });

      res.status(201).json({ exam: result });
    } catch (err: any) {
      if (err?.statusCode === 404) {
        res.status(404).json({ error: err.message });
        return;
      }
      next(err);
    }
  }
);

// ---------------------------------------------------------------------
// POST /api/v1/mcq/upload
// ---------------------------------------------------------------------

const UploadBodySchema = z.object({ exam_id: z.string().uuid() });

/**
 * POST /api/v1/mcq/upload
 * Accepts one file (JPG/PNG/PDF/ZIP of scans) via multipart/form-data,
 * field name "file". A ZIP is expanded into individual page files, each
 * ingested as its own sheet. Every sheet is processed synchronously so
 * the response reflects real, final status (not a queued promise) —
 * batches are expected to be exam-day-sized (dozens–low hundreds), not
 * the million-candidate recruitment volumes handled elsewhere in UROS.
 */
router.post(
  "/upload",
  authenticate,
  rbac("ADMIN", "RECRUITER", "SENIOR_RECRUITER"),
  importRateLimit,
  upload.single("file"),
  validate({ body: UploadBodySchema }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { exam_id } = req.body as z.infer<typeof UploadBodySchema>;
      const orgId = req.user!.org_id;

      if (!req.file) {
        res.status(400).json({ error: "No file uploaded (expected multipart field 'file')" });
        return;
      }

      const examRes = await db.query(`SELECT exam_id FROM mcq_exams WHERE exam_id=$1 AND org_id=$2`, [exam_id, orgId]);
      if (examRes.rowCount === 0) {
        res.status(404).json({ error: "Exam not found in this org" });
        return;
      }

      const files = expandUpload(req.file.originalname, req.file.buffer, req.file.mimetype);
      if (files.length === 0) {
        res.status(400).json({ error: "No JPG/PNG/PDF pages found in upload" });
        return;
      }

      // Per-file error isolation (Agent-Level Hardening): a ZIP of scanned
      // pages is a batch, and one corrupt page must not discard the other
      // 49. Each file is ingested through the runner (timeout, retry,
      // circuit, audit); failures are collected and reported back instead of
      // turning a partial success into a 500.
      const ingest = await runBatchIsolated(
        {
          agentName: AGENT_NAMES.EXAM_SCANNER_INGEST_FILE,
          agentClass: "scanner",
          items: files,
          itemKey: (file, index) => file.filename || `page:${index}`,
          actor: req.user!.user_id,
          request_id: req.requestId,
          entity_type: "MCQ_UPLOAD",
          processItem: (file) =>
            invoke(
              AGENT_NAMES.EXAM_SCANNER_INGEST_FILE,
              { exam_id, org_id: orgId, file, actor_user_id: req.user!.user_id },
              {
                actor: req.user!.user_id,
                entity_type: "MCQ_UPLOAD",
                entity_id: exam_id,
                request_id: req.requestId,
              }
            ),
        }
      );
      const sheetIds = ingest.results.map((r) => r.result);

      if (sheetIds.length === 0) {
        // Nothing at all could be ingested — that is a failed upload, not an
        // empty success. The per-file reasons tell the operator what to fix.
        res.status(400).json({
          error: "No sheets could be ingested from this upload",
          failed: ingest.failures,
        });
        return;
      }

      await logAudit({
        entity_type: "MCQ_UPLOAD",
        entity_id: exam_id,
        agent_or_user: req.user!.user_id,
        action: "MCQ_SHEETS_UPLOADED",
        output_value: {
          sheet_count: sheetIds.length,
          failed_count: ingest.failed,
          source_filename: req.file.originalname,
        },
      });

      const sheetsRes = await db.query(`SELECT * FROM mcq_answer_sheets WHERE sheet_id = ANY($1::uuid[])`, [sheetIds]);
      res.status(201).json({ sheets: sheetsRes.rows, count: sheetsRes.rowCount, failed: ingest.failures });
    } catch (err) {
      next(err);
    }
  }
);

// ---------------------------------------------------------------------
// GET /api/v1/mcq/results/:exam_id
// ---------------------------------------------------------------------

const ExamIdParamSchema = z.object({ exam_id: z.string().uuid() });

/**
 * GET /api/v1/mcq/results/:exam_id
 * Exam-level summary: every sheet's result plus counts by status, so the
 * scorecard/export view has everything it needs in one call.
 */
router.get(
  "/results/:exam_id",
  authenticate,
  validate({ params: ExamIdParamSchema }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { exam_id } = req.params as unknown as z.infer<typeof ExamIdParamSchema>;
      const orgId = req.user!.org_id;

      const examRes = await db.query(`SELECT * FROM mcq_exams WHERE exam_id=$1 AND org_id=$2`, [exam_id, orgId]);
      if (examRes.rowCount === 0) {
        res.status(404).json({ error: "Exam not found in this org" });
        return;
      }

      const resultsRes = await db.query(
        `SELECT s.sheet_id, s.roll_no, s.status AS sheet_status, s.candidate_id, r.*
         FROM mcq_answer_sheets s
         LEFT JOIN mcq_results r ON r.sheet_id = s.sheet_id
         WHERE s.exam_id=$1
         ORDER BY s.uploaded_at ASC`,
        [exam_id]
      );

      const sheetCountRes = await db.query(
        `SELECT status, COUNT(*)::int AS count FROM mcq_answer_sheets WHERE exam_id=$1 GROUP BY status`,
        [exam_id]
      );

      res.status(200).json({
        exam: examRes.rows[0],
        results: resultsRes.rows,
        count: resultsRes.rowCount,
        status_counts: sheetCountRes.rows,
      });
    } catch (err) {
      next(err);
    }
  }
);

// ---------------------------------------------------------------------
// GET /api/v1/mcq/sheets/:sheet_id
// ---------------------------------------------------------------------

const SheetIdParamSchema = z.object({ sheet_id: z.string().uuid() });

/**
 * GET /api/v1/mcq/sheets/:sheet_id
 * Full sheet detail: the sheet row (incl. file_path for the original
 * image overlay), every detected mcq_sheet_answers row (the evidence
 * panel), and the current mcq_results row if scored.
 */
router.get(
  "/sheets/:sheet_id",
  authenticate,
  validate({ params: SheetIdParamSchema }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { sheet_id } = req.params as unknown as z.infer<typeof SheetIdParamSchema>;

      const sheetRes = await db.query(
        `SELECT s.* FROM mcq_answer_sheets s JOIN mcq_exams e ON e.exam_id = s.exam_id
         WHERE s.sheet_id=$1 AND e.org_id=$2`,
        [sheet_id, req.user!.org_id]
      );
      if (sheetRes.rowCount === 0) {
        res.status(404).json({ error: "Sheet not found" });
        return;
      }

      const answersRes = await db.query(
        `SELECT * FROM mcq_sheet_answers WHERE sheet_id=$1 ORDER BY question_no ASC`,
        [sheet_id]
      );
      const resultRes = await db.query(`SELECT * FROM mcq_results WHERE sheet_id=$1`, [sheet_id]);

      res.status(200).json({
        sheet: sheetRes.rows[0],
        answers: answersRes.rows,
        result: resultRes.rows[0] ?? null,
      });
    } catch (err) {
      next(err);
    }
  }
);

// ---------------------------------------------------------------------
// PATCH /api/v1/mcq/sheets/:sheet_id
// ---------------------------------------------------------------------

const ReviewBodySchema = z
  .object({
    action: z.enum(["CONFIRM", "CORRECT", "REJECT", "RESCAN"]),
    reason: z.string().min(1, "reason is mandatory for every human review decision"),
    roll_no: z.string().optional(), // CORRECT: human-corrected roll number
    corrections: z.array(z.object({ question_no: z.number().int().min(1), corrected_option: OptionEnum.nullable() })).optional(), // CORRECT: per-question fixes
  })
  .refine((d) => d.action !== "CORRECT" || (!!d.roll_no || (d.corrections && d.corrections.length > 0)), {
    message: "CORRECT requires roll_no and/or corrections",
    path: ["corrections"],
  });

/**
 * PATCH /api/v1/mcq/sheets/:sheet_id
 * Human-in-the-loop resolution of a flagged (or any) sheet:
 * - CONFIRM: accept the system's detections/score as-is.
 * - CORRECT: apply roll_no and/or per-question corrected_option fixes,
 *   then rescore deterministically from the corrected answers.
 * - REJECT: mark the sheet rejected (excluded from results); e.g. wrong
 *   candidate's sheet, unreadable, duplicate.
 * - RESCAN: mark the sheet as needing a fresh physical scan/upload.
 * Every action requires a mandatory reason and is fully audited — this
 * is the only path by which a sheet's result is ever treated as final.
 */
router.patch(
  "/sheets/:sheet_id",
  authenticate,
  rbac("RECRUITER", "SENIOR_RECRUITER", "ADMIN"),
  validate({ params: SheetIdParamSchema, body: ReviewBodySchema }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { sheet_id } = req.params as unknown as z.infer<typeof SheetIdParamSchema>;
      const { action, reason, roll_no, corrections } = req.body as z.infer<typeof ReviewBodySchema>;

      const sheetRes = await db.query(
        `SELECT s.* FROM mcq_answer_sheets s JOIN mcq_exams e ON e.exam_id = s.exam_id
         WHERE s.sheet_id=$1 AND e.org_id=$2`,
        [sheet_id, req.user!.org_id]
      );
      if (sheetRes.rowCount === 0) {
        res.status(404).json({ error: "Sheet not found" });
        return;
      }
      const sheet = sheetRes.rows[0];

      let updatedSheet;

      if (action === "CONFIRM") {
        const upd = await db.query(
          `UPDATE mcq_answer_sheets SET status='CONFIRMED', reviewed_by=$1, review_reason=$2, reviewed_at=now() WHERE sheet_id=$3 RETURNING *`,
          [req.user!.user_id, reason, sheet_id]
        );
        updatedSheet = upd.rows[0];
        await db.query(`UPDATE mcq_results SET needs_review=false WHERE sheet_id=$1`, [sheet_id]);
      } else if (action === "REJECT") {
        const upd = await db.query(
          `UPDATE mcq_answer_sheets SET status='REJECTED', reviewed_by=$1, review_reason=$2, reviewed_at=now() WHERE sheet_id=$3 RETURNING *`,
          [req.user!.user_id, reason, sheet_id]
        );
        updatedSheet = upd.rows[0];
      } else if (action === "RESCAN") {
        const upd = await db.query(
          `UPDATE mcq_answer_sheets SET status='RESCAN_REQUESTED', reviewed_by=$1, review_reason=$2, reviewed_at=now() WHERE sheet_id=$3 RETURNING *`,
          [req.user!.user_id, reason, sheet_id]
        );
        updatedSheet = upd.rows[0];
      } else {
        // CORRECT
        await db.withTransaction(async (client) => {
          if (roll_no) {
            await client.query(`UPDATE mcq_answer_sheets SET roll_no=$1 WHERE sheet_id=$2`, [roll_no, sheet_id]);
          }
          for (const c of corrections ?? []) {
            await client.query(
              `UPDATE mcq_sheet_answers SET corrected_option=$1, status='CORRECTED' WHERE sheet_id=$2 AND question_no=$3`,
              [c.corrected_option, sheet_id, c.question_no]
            );
          }
        });

        const examRes = await db.query(`SELECT * FROM mcq_exams WHERE exam_id=$1`, [sheet.exam_id]);
        const exam = examRes.rows[0];
        const keyRes = await db.query(
          `SELECT question_no, correct_option FROM mcq_answer_keys WHERE exam_id=$1 AND active=true`,
          [sheet.exam_id]
        );
        const answerKey: Record<number, McqOption> = {};
        for (const row of keyRes.rows) answerKey[row.question_no] = row.correct_option;

        const answersRes = await db.query(`SELECT * FROM mcq_sheet_answers WHERE sheet_id=$1`, [sheet_id]);
        const scoring = scoreSheet(
          answersRes.rows.map((a: any) => ({
            question_no: a.question_no,
            detected_option: a.detected_option,
            status: a.status,
            corrected_option: a.corrected_option,
          })),
          answerKey,
          {
            total_questions: exam.total_questions,
            marks_per_question: Number(exam.marks_per_question),
            negative_mark: Number(exam.negative_mark),
            pass_threshold: exam.pass_threshold !== null ? Number(exam.pass_threshold) : null,
          }
        );

        await db.withTransaction(async (client) => {
          await client.query(
            `UPDATE mcq_results SET correct_count=$1, wrong_count=$2, skipped_count=$3, negative_total=$4, final_score=$5, passed=$6, needs_review=false
             WHERE sheet_id=$7`,
            [scoring.correct_count, scoring.wrong_count, scoring.skipped_count, scoring.negative_total, scoring.final_score, scoring.passed, sheet_id]
          );
          const upd = await client.query(
            `UPDATE mcq_answer_sheets SET status='CONFIRMED', reviewed_by=$1, review_reason=$2, reviewed_at=now() WHERE sheet_id=$3 RETURNING *`,
            [req.user!.user_id, reason, sheet_id]
          );
          updatedSheet = upd.rows[0];
        });
      }

      await logAudit({
        entity_type: "MCQ_SHEET",
        entity_id: sheet_id,
        agent_or_user: req.user!.user_id,
        action: `MCQ_SHEET_${action}`,
        reason_comment: reason,
        input_value: { roll_no: roll_no ?? undefined, corrections: corrections ?? undefined },
      });

      res.status(200).json({ sheet: updatedSheet });
    } catch (err) {
      next(err);
    }
  }
);

// ─── Quest 05 Part 8: MCQ Sheet Image Download ──────────────────────

/**
 * GET /api/v1/mcq/sheets/:sheet_id/image
 * Serve the original scanned image file for a given MCQ answer sheet.
 */
router.get(
  "/sheets/:sheet_id/image",
  authenticate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { sheet_id } = req.params;

      const sheetRes = await db.query(
        `SELECT s.file_path, s.file_name FROM mcq_answer_sheets s
         JOIN mcq_exams e ON e.exam_id = s.exam_id
         WHERE s.sheet_id=$1 AND e.org_id=$2`,
        [sheet_id, req.user!.org_id]
      );
      if (sheetRes.rowCount === 0) {
        res.status(404).json({ error: "Sheet not found" });
        return;
      }

      const { file_path, file_name } = sheetRes.rows[0];
      if (!file_path || !fs.existsSync(file_path)) {
        res.status(404).json({ error: "Image file not found on disk" });
        return;
      }

      await logAudit({
        org_id: req.user!.org_id,
        entity_type: "MCQ_SHEET",
        entity_id: sheet_id,
        agent_or_user: req.user!.user_id,
        action: "FILE_DOWNLOADED",
        output_value: { format: "image", resource: "mcq_sheet_image", filename: file_name ?? path.basename(file_path) },
      });

      res.setHeader("Content-Type", "image/jpeg");
      res.setHeader("Content-Disposition", `inline; filename="${file_name ?? path.basename(file_path)}"`);
      fs.createReadStream(file_path).pipe(res);
    } catch (err) { next(err); }
  }
);

export default router;
