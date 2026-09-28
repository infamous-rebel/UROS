import { Router, Request, Response, NextFunction } from "express";
import multer from "multer";
import { z } from "zod";
import { authenticate } from "../middleware/auth";
import { rbac } from "../middleware/rbac";
import { validate } from "../middleware/validate";
import { importRateLimit, reportGenerationRateLimit } from "../middleware/rate_limit";
import { db } from "../../database/client";
import { logAudit } from "../../utils/audit_helper";
import { env } from "../../config/env.schema";
import { FileValidationError } from "../../utils/errors";
import {
  assembleExamPaper,
  exportExamPaper,
  gradeShortAnswer,
  parseUploadedExamPaper,
  publishExam,
} from "../../agents/digital_exam_agent";
import { AGENT_NAMES, invoke } from "../../services/agent_runner/agents";

const router = Router();

// Security Hardening Round: fileFilter added — matches exactly what
// parseUploadedExamPaper() handles (PDF, .docx, JPEG/PNG scans, plain
// text). A 20MB limit was already present; kept as-is (PDF/document
// exam papers, not batch archives, so no need for MCQ's larger 50MB).
const EXAM_ALLOWED_MIME_TYPES = new Set([
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "image/jpeg",
  "image/png",
  "text/plain",
]);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const lowerName = file.originalname.toLowerCase();
    const hasAllowedExtension = /\.(pdf|docx|jpe?g|png|txt)$/.test(lowerName);
    if (EXAM_ALLOWED_MIME_TYPES.has(file.mimetype) && hasAllowedExtension) {
      cb(null, true);
      return;
    }
    cb(
      new FileValidationError(
        `Unsupported file type: ${file.mimetype || "unknown"} (${file.originalname}). Only PDF, DOCX, JPEG, PNG, or TXT are accepted.`
      )
    );
  },
});

const QuestionTypeEnum = z.enum(["MCQ", "SHORT_ANSWER"]);

const McqOptionSchema = z.object({ key: z.string().min(1).max(2), text: z.string().min(1) });

const QuestionInputSchema = z
  .object({
    question_type: QuestionTypeEnum,
    question_text: z.string().min(1),
    options: z.array(McqOptionSchema).optional(),
    correct_answer: z.string().optional(),
    marks: z.number().min(0).default(1),
    negative_mark: z.number().min(0).default(0),
    order_index: z.number().int().min(1),
    source: z.enum(["MANUAL", "QUESTION_BANK", "PARSED"]).default("MANUAL"),
    bank_question_id: z.string().uuid().optional(),
  })
  .refine((q) => q.question_type !== "MCQ" || (q.options && q.options.length >= 2), {
    message: "MCQ questions require at least 2 options",
    path: ["options"],
  });

const SectionInputSchema = z.object({
  section_name: z.string().min(1),
  order_index: z.number().int().min(1),
  topic: z.string().optional(),
  weight: z.number().min(0).max(100).optional(),
  questions: z.array(QuestionInputSchema).default([]),
});

const ExamBodySchema = z.object({
  exam_id: z.string().uuid().optional(), // omit to create
  title: z.string().min(1),
  description: z.string().optional(),
  header_logo: z.string().optional(),
  date: z.string().optional(),
  duration_minutes: z.number().int().positive().optional(),
  persona_id: z.string().uuid().optional(),
  sections: z.array(SectionInputSchema).min(1),
});

// ---------------------------------------------------------------------
// POST /api/v1/exams — create/update exam paper (DRAFT/PENDING_APPROVAL)
// ---------------------------------------------------------------------

/**
 * POST /api/v1/exams
 * Creates a new exam (DRAFT) or fully replaces the section/question set
 * of one owned by the caller's org and still editable (not PUBLISHED —
 * publishing is a separate, explicit human-approval action via POST
 * /exams/:exam_id/publish, see below). total_marks is recomputed here,
 * never trusted from the client.
 */
router.post(
  "/",
  authenticate,
  rbac("ADMIN", "DEPT_HEAD"),
  validate({ body: ExamBodySchema }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = req.body as z.infer<typeof ExamBodySchema>;
      const orgId = req.user!.org_id;
      const totalMarks = body.sections.reduce((sum, s) => sum + s.questions.reduce((qs, q) => qs + q.marks, 0), 0);

      const exam = await db.withTransaction(async (client) => {
        let examId = body.exam_id;

        if (examId) {
          const existing = await client.query(`SELECT exam_id, status FROM digital_exams WHERE exam_id=$1 AND org_id=$2`, [examId, orgId]);
          if (existing.rowCount === 0) throw Object.assign(new Error("Exam not found in this org"), { statusCode: 404 });
          if (existing.rows[0].status === "PUBLISHED") {
            throw Object.assign(new Error("Cannot edit a PUBLISHED exam — republish creates a new version after editing a DRAFT copy"), {
              statusCode: 409,
            });
          }
          await client.query(
            `UPDATE digital_exams SET title=$1, description=$2, header_logo=$3, date=$4, duration_minutes=$5,
               persona_id=$6, total_marks=$7, updated_at=now()
             WHERE exam_id=$8`,
            [body.title, body.description ?? null, body.header_logo ?? null, body.date ?? null, body.duration_minutes ?? null, body.persona_id ?? null, totalMarks, examId]
          );
          // Full replace of sections/questions — simplest deterministic
          // semantics for a DRAFT-only editor with a "preview" workflow.
          const oldSections = await client.query(`SELECT section_id FROM exam_sections WHERE exam_id=$1`, [examId]);
          const oldSectionIds = oldSections.rows.map((r: any) => r.section_id);
          if (oldSectionIds.length) {
            await client.query(`DELETE FROM exam_questions WHERE section_id = ANY($1::uuid[])`, [oldSectionIds]);
            await client.query(`DELETE FROM exam_sections WHERE exam_id=$1`, [examId]);
          }
        } else {
          const insertRes = await client.query(
            `INSERT INTO digital_exams (org_id, title, description, header_logo, date, duration_minutes, persona_id, total_marks, created_by)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING exam_id`,
            [orgId, body.title, body.description ?? null, body.header_logo ?? null, body.date ?? null, body.duration_minutes ?? null, body.persona_id ?? null, totalMarks, req.user!.user_id]
          );
          examId = insertRes.rows[0].exam_id;
        }

        for (const section of body.sections) {
          const sectionRes = await client.query(
            `INSERT INTO exam_sections (exam_id, section_name, order_index, topic, weight) VALUES ($1,$2,$3,$4,$5) RETURNING section_id`,
            [examId, section.section_name, section.order_index, section.topic ?? null, section.weight ?? null]
          );
          const sectionId = sectionRes.rows[0].section_id;

          for (const q of section.questions) {
            await client.query(
              `INSERT INTO exam_questions
                (section_id, question_type, question_text, options, correct_answer, marks, negative_mark, order_index, source, bank_question_id)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
              [
                sectionId,
                q.question_type,
                q.question_text,
                q.options ? JSON.stringify(q.options) : null,
                q.question_type === "MCQ" ? q.correct_answer ?? null : null,
                q.marks,
                q.negative_mark,
                q.order_index,
                q.source,
                q.bank_question_id ?? null,
              ]
            );
          }
        }

        const examRes = await client.query(`SELECT * FROM digital_exams WHERE exam_id=$1`, [examId]);
        return examRes.rows[0];
      });

      await logAudit({
        entity_type: "DIGITAL_EXAM",
        entity_id: exam.exam_id,
        agent_or_user: req.user!.user_id,
        action: body.exam_id ? "DIGITAL_EXAM_UPDATED" : "DIGITAL_EXAM_CREATED",
        reason_code: body.exam_id ? "EXAM_PAPER_UPDATED" : "EXAM_PAPER_CREATED",
        reason_comment: `${body.sections.length} section(s), ${totalMarks} total marks configured by an authorized Admin/Dept Head.`,
        output_value: { title: body.title, section_count: body.sections.length, total_marks: totalMarks },
      });

      res.status(201).json({ exam });
    } catch (err: any) {
      if (err?.statusCode) {
        res.status(err.statusCode).json({ error: err.message });
        return;
      }
      next(err);
    }
  }
);

/** GET /api/v1/exams — list exams for the caller's org (for the builder's exam picker / question bank flows). */
router.get("/", authenticate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const result = await db.query(
      `SELECT exam_id, title, status, version, total_marks, date, created_at FROM digital_exams WHERE org_id=$1 ORDER BY created_at DESC`,
      [req.user!.org_id]
    );
    res.status(200).json({ exams: result.rows, count: result.rowCount });
  } catch (err) {
    next(err);
  }
});

/** GET /api/v1/exams/question-bank — reusable question bank for this org, optionally filtered by topic. */
router.get(
  "/question-bank",
  authenticate,
  validate({ query: z.object({ topic: z.string().optional() }) }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { topic } = req.query as { topic?: string };
      const result = topic
        ? await db.query(`SELECT * FROM exam_question_bank WHERE org_id=$1 AND topic=$2 ORDER BY created_at DESC`, [req.user!.org_id, topic])
        : await db.query(`SELECT * FROM exam_question_bank WHERE org_id=$1 ORDER BY created_at DESC`, [req.user!.org_id]);
      res.status(200).json({ questions: result.rows, count: result.rowCount });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * POST /api/v1/exams/parse
 * Uploads an exam paper (.docx, image, .txt) and returns deterministic,
 * regex-parsed question drafts for the builder to review/edit — nothing
 * is persisted here. PDF is explicitly unsupported (see agent
 * docstring) and returns a clear error instead of guessing.
 */
router.post(
  "/parse",
  authenticate,
  rbac("ADMIN", "DEPT_HEAD"),
  importRateLimit,
  upload.single("file"),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!req.file) {
        res.status(400).json({ error: "No file uploaded (expected multipart field 'file')" });
        return;
      }
      const result = await parseUploadedExamPaper(req.file.originalname, req.file.buffer, req.file.mimetype);

      await logAudit({
        entity_type: "DIGITAL_EXAM_PARSE",
        entity_id: req.user!.org_id,
        agent_or_user: req.user!.user_id,
        action: "DIGITAL_EXAM_PAPER_PARSED",
        reason_code: result.error ? "EXAM_PAPER_PARSE_UNSUPPORTED" : "EXAM_PAPER_PARSED_FOR_REVIEW",
        reason_comment: result.error ?? `Deterministic regex parse produced ${result.drafts.length} draft question(s) for human review before creation.`,
        output_value: { filename: req.file.originalname, question_count: result.drafts.length, source_kind: result.source_kind, error: result.error },
      });

      res.status(result.error ? 422 : 200).json(result);
    } catch (err) {
      next(err);
    }
  }
);

// ---------------------------------------------------------------------
// GET /api/v1/exams/:exam_id — get full paper
// ---------------------------------------------------------------------

const ExamIdParamSchema = z.object({ exam_id: z.string().uuid() });

router.get(
  "/:exam_id",
  authenticate,
  validate({ params: ExamIdParamSchema }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { exam_id } = req.params as unknown as z.infer<typeof ExamIdParamSchema>;
      // Admin/recruiting roles see answers; APPLICANT never does.
      const includeAnswers = req.user!.role !== "APPLICANT";
      const paper = await assembleExamPaper(exam_id, req.user!.org_id, includeAnswers);
      res.status(200).json({ paper });
    } catch (err: any) {
      if (/not found/i.test(err?.message ?? "")) {
        res.status(404).json({ error: err.message });
        return;
      }
      next(err);
    }
  }
);

/**
 * POST /api/v1/exams/:exam_id/publish
 * The mandatory human approval gate: snapshots the current paper into
 * digital_exam_versions and flips status to PUBLISHED. A published exam
 * can be taken/exported/scored; a DRAFT cannot.
 */
router.post(
  "/:exam_id/publish",
  authenticate,
  rbac("ADMIN", "DEPT_HEAD"),
  validate({ params: ExamIdParamSchema }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { exam_id } = req.params as unknown as z.infer<typeof ExamIdParamSchema>;
      await publishExam(exam_id, req.user!.org_id, req.user!.user_id);
      const examRes = await db.query(`SELECT * FROM digital_exams WHERE exam_id=$1`, [exam_id]);
      res.status(200).json({ exam: examRes.rows[0] });
    } catch (err: any) {
      if (/no questions|not found/i.test(err?.message ?? "")) {
        res.status(400).json({ error: err.message });
        return;
      }
      next(err);
    }
  }
);

// ---------------------------------------------------------------------
// POST /api/v1/exams/:exam_id/submit — candidate submission
// ---------------------------------------------------------------------

const SubmitBodySchema = z.object({
  candidate_id: z.string().min(1).optional(),
  answers: z.array(z.object({ question_id: z.string().uuid(), answer: z.string().nullable() })).min(1),
});

router.post(
  "/:exam_id/submit",
  authenticate,
  validate({ params: ExamIdParamSchema, body: SubmitBodySchema }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { exam_id } = req.params as unknown as z.infer<typeof ExamIdParamSchema>;
      const { candidate_id, answers } = req.body as z.infer<typeof SubmitBodySchema>;

      const examRes = await db.query(`SELECT status FROM digital_exams WHERE exam_id=$1 AND org_id=$2`, [exam_id, req.user!.org_id]);
      if (examRes.rowCount === 0) {
        res.status(404).json({ error: "Exam not found in this org" });
        return;
      }
      if (examRes.rows[0].status !== "PUBLISHED") {
        res.status(409).json({ error: "Exam is not published — submissions are not accepted for a DRAFT exam" });
        return;
      }

      const insertRes = await db.query(
        `INSERT INTO digital_exam_submissions (exam_id, candidate_id, answers) VALUES ($1,$2,$3) RETURNING *`,
        [exam_id, candidate_id ?? null, JSON.stringify(answers)]
      );

      await logAudit({
        entity_type: "DIGITAL_EXAM_SUBMISSION",
        entity_id: insertRes.rows[0].submission_id,
        agent_or_user: req.user!.user_id,
        action: "DIGITAL_EXAM_SUBMITTED",
        reason_code: "SUBMISSION_RECEIVED",
        reason_comment: `Submission recorded with ${answers.length} answer(s) for a PUBLISHED exam; not yet scored.`,
        input_value: { exam_id, candidate_id: candidate_id ?? null, answer_count: answers.length },
      });

      res.status(201).json({ submission: insertRes.rows[0] });
    } catch (err) {
      next(err);
    }
  }
);

// ---------------------------------------------------------------------
// POST /api/v1/exams/:exam_id/score — admin trigger scoring
// ---------------------------------------------------------------------

const ScoreBodySchema = z.object({ submission_id: z.string().uuid() });

router.post(
  "/:exam_id/score",
  authenticate,
  rbac("ADMIN", "SENIOR_RECRUITER"),
  validate({ params: ExamIdParamSchema, body: ScoreBodySchema }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { submission_id } = req.body as z.infer<typeof ScoreBodySchema>;
      // Through the generic runner (Agent-Level Hardening). Scoring a
      // submission walks its answers in memory and writes one row in a
      // transaction, so there is no per-candidate loop to isolate here; the
      // runner supplies the timeout, retry, circuit, log and audit trail.
      // The agent's own errors are re-thrown unchanged, so the 404 mapping
      // below is unaffected.
      const scoring = await invoke(
        AGENT_NAMES.DIGITAL_EXAM_SCORE_SUBMISSION,
        { submission_id, org_id: req.user!.org_id, actor_user_id: req.user!.user_id },
        {
          actor: req.user!.user_id,
          entity_type: "EXAM_SUBMISSION",
          entity_id: submission_id,
          request_id: req.requestId,
        }
      );
      res.status(200).json({ scoring });
    } catch (err: any) {
      if (/not found/i.test(err?.message ?? "")) {
        res.status(404).json({ error: err.message });
        return;
      }
      next(err);
    }
  }
);

/**
 * PATCH /api/v1/exams/:exam_id/submissions/:submission_id/grade
 * Human grading of one SHORT_ANSWER question — mandatory reason. Not in
 * the original literal route list, but required to close the loop on
 * "no black-box, no LLM" short-answer scoring: a human must be able to
 * actually award the marks that auto-scoring correctly refuses to guess.
 */
const GradeBodySchema = z.object({
  question_id: z.string().uuid(),
  marks_awarded: z.number().min(0),
  reason: z.string().min(1, "reason is mandatory for every manual grade"),
});

router.patch(
  "/:exam_id/submissions/:submission_id/grade",
  authenticate,
  rbac("RECRUITER", "SENIOR_RECRUITER", "ADMIN"),
  validate({ params: z.object({ exam_id: z.string().uuid(), submission_id: z.string().uuid() }), body: GradeBodySchema }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { submission_id } = req.params as unknown as { exam_id: string; submission_id: string };
      const { question_id, marks_awarded, reason } = req.body as z.infer<typeof GradeBodySchema>;

      await gradeShortAnswer(submission_id, question_id, marks_awarded, req.user!.org_id, req.user!.user_id, reason);
      const subRes = await db.query(`SELECT * FROM digital_exam_submissions WHERE submission_id=$1`, [submission_id]);
      res.status(200).json({ submission: subRes.rows[0] });
    } catch (err: any) {
      if (/not found|not a SHORT_ANSWER/i.test(err?.message ?? "")) {
        res.status(400).json({ error: err.message });
        return;
      }
      next(err);
    }
  }
);

// ---------------------------------------------------------------------
// GET /api/v1/exams/:exam_id/results
// ---------------------------------------------------------------------

router.get(
  "/:exam_id/results",
  authenticate,
  validate({ params: ExamIdParamSchema }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { exam_id } = req.params as unknown as z.infer<typeof ExamIdParamSchema>;
      const examRes = await db.query(`SELECT * FROM digital_exams WHERE exam_id=$1 AND org_id=$2`, [exam_id, req.user!.org_id]);
      if (examRes.rowCount === 0) {
        res.status(404).json({ error: "Exam not found in this org" });
        return;
      }
      const submissionsRes = await db.query(
        `SELECT * FROM digital_exam_submissions WHERE exam_id=$1 ORDER BY submitted_at ASC`,
        [exam_id]
      );
      const statusCountsRes = await db.query(
        `SELECT status, COUNT(*)::int AS count FROM digital_exam_submissions WHERE exam_id=$1 GROUP BY status`,
        [exam_id]
      );
      res.status(200).json({ exam: examRes.rows[0], submissions: submissionsRes.rows, count: submissionsRes.rowCount, status_counts: statusCountsRes.rows });
    } catch (err) {
      next(err);
    }
  }
);

// ---------------------------------------------------------------------
// GET /api/v1/exams/:exam_id/export?format=pdf|docx|interactive_pdf|link
// ---------------------------------------------------------------------

const ExportQuerySchema = z.object({ format: z.enum(["pdf", "docx", "interactive_pdf", "link"]) });

router.get(
  "/:exam_id/export",
  authenticate,
  reportGenerationRateLimit,
  validate({ params: ExamIdParamSchema, query: ExportQuerySchema }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { exam_id } = req.params as unknown as z.infer<typeof ExamIdParamSchema>;
      const { format } = req.query as unknown as z.infer<typeof ExportQuerySchema>;

      const result = await exportExamPaper(exam_id, req.user!.org_id, format, env.APP_PUBLIC_URL);

      await logAudit({
        entity_type: "DIGITAL_EXAM",
        entity_id: exam_id,
        agent_or_user: req.user!.user_id,
        action: "DIGITAL_EXAM_EXPORTED",
        reason_code: "EXAM_EXPORT_REQUESTED",
        reason_comment: `Exported as ${format} by an authenticated user for distribution/record-keeping.`,
        output_value: { format },
      });

      if (format === "link") {
        res.status(200).json({ link: result.link });
        return;
      }

      res.setHeader("Content-Type", result.contentType);
      res.setHeader("Content-Disposition", `attachment; filename="${result.filename}"`);
      res.status(200).send(result.buffer);
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
