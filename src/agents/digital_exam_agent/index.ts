import { createWorker } from "tesseract.js";
import AdmZip from "adm-zip";
import PDFDocument from "pdfkit";
import { Document, Packer, Paragraph, TextRun, HeadingLevel } from "docx";
import { db } from "../../database/client";
import { logAudit } from "../../utils/audit_helper";
import {
  AssembledExamPaper,
  DigitalExamScoringOutput,
  ExamQuestion,
  ExamSection,
  ExportFormat,
  ParsedQuestionDraft,
  QuestionEvidence,
  QuestionScoreEvidence,
  SubmissionAnswer,
  SubmissionReasonCode,
} from "../../models/digital_exam.model";

// ---------------------------------------------------------------------
// Assembly — deterministic section/question ordering. No randomness, no
// model: the same exam_id always assembles into the exact same paper.
// ---------------------------------------------------------------------

/**
 * Assembles the full exam paper: exam row + sections (order_index ASC) +
 * questions per section (order_index ASC). `includeAnswers=false` strips
 * `correct_answer` (marks/negative_mark stay visible — those are the
 * rubric, not the answer) for candidate-facing exports/links.
 */
export async function assembleExamPaper(examId: string, orgId: string, includeAnswers: boolean): Promise<AssembledExamPaper> {
  const examRes = await db.query(`SELECT * FROM digital_exams WHERE exam_id=$1 AND org_id=$2`, [examId, orgId]);
  if (examRes.rowCount === 0) throw new Error(`Exam not found: ${examId}`);
  const exam = examRes.rows[0];

  const sectionsRes = await db.query<ExamSection>(
    `SELECT * FROM exam_sections WHERE exam_id=$1 ORDER BY order_index ASC`,
    [examId]
  );

  const sectionIds = sectionsRes.rows.map((s) => s.section_id);
  const questionsRes = sectionIds.length
    ? await db.query<ExamQuestion>(
        `SELECT * FROM exam_questions WHERE section_id = ANY($1::uuid[]) ORDER BY order_index ASC`,
        [sectionIds]
      )
    : { rows: [] as ExamQuestion[] };

  const questionsBySection: Record<string, ExamQuestion[]> = {};
  for (const q of questionsRes.rows) {
    const question = includeAnswers ? q : { ...q, correct_answer: null };
    (questionsBySection[q.section_id] ??= []).push(question);
  }

  return {
    exam,
    sections: sectionsRes.rows.map((s) => ({ ...s, questions: questionsBySection[s.section_id] ?? [] })),
  };
}

// ---------------------------------------------------------------------
// Scoring — pure and deterministic. MCQ: exact-match against
// correct_answer, marks/negative_mark applied. SHORT_ANSWER: never
// auto-graded — free-text grading requires human judgment (or a model,
// which UROS does not use here), so every short-answer question is
// PENDING_MANUAL_GRADE and forces needs_review=true on the submission.
// ---------------------------------------------------------------------

export function scoreSubmission(answers: SubmissionAnswer[], questions: ExamQuestion[]): DigitalExamScoringOutput {
  const answerByQuestion = new Map(answers.map((a) => [a.question_id, a.answer]));
  const breakdown: QuestionScoreEvidence[] = [];
  let autoScore = 0;
  let maxMarks = 0;
  let needsReview = false;

  for (const q of questions) {
    maxMarks += q.marks;
    const submitted = answerByQuestion.has(q.question_id) ? answerByQuestion.get(q.question_id) ?? null : null;

    const baseEvidence: QuestionEvidence = {
      question_text: q.question_text,
      submitted_answer: submitted,
      correct_answer: q.question_type === "MCQ" ? q.correct_answer : null,
      marks_available: q.marks,
      negative_mark: q.negative_mark,
      rule_applied: "",
    };

    if (q.question_type === "SHORT_ANSWER") {
      // Never auto-graded — always routed to a human, regardless of
      // whether the candidate answered.
      needsReview = true;
      breakdown.push({
        question_id: q.question_id,
        question_type: q.question_type,
        reason_code: "SHORT_ANSWER_PENDING_MANUAL_GRADE",
        reason_description:
          "Short-answer questions cannot be scored deterministically (no ML/LLM grading is used) — a human reviewer must award marks.",
        evidence: {
          ...baseEvidence,
          rule_applied: "SHORT_ANSWER questions are never auto-scored; routed to PATCH .../grade for human marking.",
        },
        marks_awarded: 0,
        outcome: "PENDING_MANUAL_GRADE",
      });
      continue;
    }

    // MCQ
    if (submitted === null || submitted === undefined || submitted === "") {
      breakdown.push({
        question_id: q.question_id,
        question_type: q.question_type,
        reason_code: "MCQ_SKIPPED_NO_ANSWER",
        reason_description: "No answer was submitted for this question — scored as skipped, no marks awarded, no penalty applied.",
        evidence: { ...baseEvidence, rule_applied: "Blank/missing submission -> 0 marks, no negative marking applied." },
        marks_awarded: 0,
        outcome: "SKIPPED",
      });
      continue;
    }

    const isCorrect = q.correct_answer !== null && submitted.trim().toUpperCase() === q.correct_answer.trim().toUpperCase();
    if (isCorrect) {
      autoScore += q.marks;
      breakdown.push({
        question_id: q.question_id,
        question_type: q.question_type,
        reason_code: "MCQ_CORRECT_MATCH",
        reason_description: `Submitted answer "${submitted}" matches the configured correct answer "${q.correct_answer}" — full marks awarded.`,
        evidence: {
          ...baseEvidence,
          rule_applied: "Exact case-insensitive match of submitted_answer against exam_questions.correct_answer.",
        },
        marks_awarded: q.marks,
        outcome: "CORRECT",
      });
    } else {
      autoScore -= q.negative_mark;
      breakdown.push({        question_id: q.question_id,
        question_type: q.question_type,
        reason_code: "MCQ_WRONG_ANSWER",
        reason_description: `Submitted answer "${submitted}" does not match the configured correct answer "${q.correct_answer}" — ${
          q.negative_mark > 0 ? `${q.negative_mark} mark(s) deducted (negative marking).` : "no marks awarded (no negative marking configured)."
        }`,
        evidence: {
          ...baseEvidence,
          rule_applied: "Exact case-insensitive match of submitted_answer against exam_questions.correct_answer.",
        },
        marks_awarded: -q.negative_mark || 0,
        outcome: "WRONG",
      });
    }
  }

  const hasPending = breakdown.some((b) => b.outcome === "PENDING_MANUAL_GRADE");
  const overallReasonCode: SubmissionReasonCode = hasPending ? "PENDING_MANUAL_GRADE_SHORT_ANSWER_PRESENT" : "AUTO_SCORED_ALL_MCQ";
  const overallReasonDescription = hasPending
    ? "This submission includes one or more SHORT_ANSWER questions, which are never auto-graded — a human must grade each before a final score is complete."
    : "Every question in this paper is MCQ; the score was computed deterministically from the configured answer key with no human input required.";

  return {
    auto_score: Math.round(autoScore * 100) / 100,
    max_marks: Math.round(maxMarks * 100) / 100,
    needs_review: needsReview,
    reason_code: overallReasonCode,
    reason_description: overallReasonDescription,
    breakdown,
  };
}

/**
 * Scores a persisted submission end-to-end: load exam questions ->
 * score -> persist score/status/breakdown -> audit.
 */
export async function scoreDigitalSubmission(submissionId: string, orgId: string, actorUserId: string): Promise<DigitalExamScoringOutput> {
  const subRes = await db.query(`SELECT * FROM digital_exam_submissions WHERE submission_id=$1`, [submissionId]);
  if (subRes.rowCount === 0) throw new Error(`Submission not found: ${submissionId}`);
  const submission = subRes.rows[0];

  const examRes = await db.query(`SELECT exam_id FROM digital_exams WHERE exam_id=$1 AND org_id=$2`, [submission.exam_id, orgId]);
  if (examRes.rowCount === 0) throw new Error(`Exam not found in this org: ${submission.exam_id}`);

  const questionsRes = await db.query<ExamQuestion>(
    `SELECT q.* FROM exam_questions q JOIN exam_sections s ON s.section_id = q.section_id
     WHERE s.exam_id=$1 ORDER BY s.order_index ASC, q.order_index ASC`,
    [submission.exam_id]
  );

  const scoring = scoreSubmission(submission.answers as SubmissionAnswer[], questionsRes.rows);
  const newStatus = scoring.needs_review ? "NEEDS_REVIEW" : "SCORED";

  await db.query(
    `UPDATE digital_exam_submissions SET score=$1, status=$2, needs_review=$3, reason_code=$4, reason_description=$5, score_breakdown=$6 WHERE submission_id=$7`,
    [scoring.auto_score, newStatus, scoring.needs_review, scoring.reason_code, scoring.reason_description, JSON.stringify(scoring.breakdown), submissionId]
  );

  await logAudit({
    org_id: orgId,
    entity_type: "DIGITAL_EXAM_SUBMISSION",
    entity_id: submissionId,
    agent_or_user: actorUserId,
    action: "DIGITAL_EXAM_SUBMISSION_SCORED",
    reason_code: scoring.reason_code,
    reason_comment: scoring.reason_description,
    output_value: { auto_score: scoring.auto_score, max_marks: scoring.max_marks, needs_review: scoring.needs_review },
  });

  return scoring;
}

/**
 * Human grading of one SHORT_ANSWER question within a submission —
 * mandatory reason, always audited. Recomputes the submission's total
 * score from the full breakdown and flips status to GRADED once every
 * short-answer question in the paper has been graded.
 *
 * Security Hardening Round: orgId is now mandatory and validated via a
 * join to digital_exams — previously this had no org check at all,
 * unlike its sibling scoreDigitalSubmission, so a grader from any org
 * could grade (assign marks to) any other org's submission.
 */
export async function gradeShortAnswer(
  submissionId: string,
  questionId: string,
  marksAwarded: number,
  orgId: string,
  graderUserId: string,
  reason: string
): Promise<void> {
  const subRes = await db.query(
    `SELECT s.* FROM digital_exam_submissions s
     JOIN digital_exams e ON e.exam_id = s.exam_id
     WHERE s.submission_id=$1 AND e.org_id=$2`,
    [submissionId, orgId]
  );
  if (subRes.rowCount === 0) throw new Error(`Submission not found: ${submissionId}`);
  const submission = subRes.rows[0];

  const breakdown: QuestionScoreEvidence[] = (submission.score_breakdown ?? []) as QuestionScoreEvidence[];
  const idx = breakdown.findIndex((b) => b.question_id === questionId);
  if (idx === -1) throw new Error(`Question ${questionId} not found on submission ${submissionId}`);
  if (breakdown[idx].question_type !== "SHORT_ANSWER") {
    throw new Error(`Question ${questionId} is not a SHORT_ANSWER question and cannot be manually graded`);
  }

  const clampedMarks = Math.max(0, Math.min(breakdown[idx].evidence.marks_available, marksAwarded));
  breakdown[idx] = {
    ...breakdown[idx],
    marks_awarded: clampedMarks,
    outcome: "CORRECT",
    reason_code: "SHORT_ANSWER_MANUALLY_GRADED",
    reason_description: `Manually graded by a human reviewer: ${clampedMarks} of ${breakdown[idx].evidence.marks_available} marks awarded. Reason: ${reason}`,
    evidence: { ...breakdown[idx].evidence, rule_applied: "Human-awarded marks via PATCH .../grade — never auto-scored." },
  };

  const stillPending = breakdown.some((b) => b.outcome === "PENDING_MANUAL_GRADE");
  const totalScore = Math.round(breakdown.reduce((sum, b) => sum + b.marks_awarded, 0) * 100) / 100;
  const newStatus = stillPending ? "NEEDS_REVIEW" : "GRADED";
  const overallReasonCode: SubmissionReasonCode = stillPending ? "PENDING_MANUAL_GRADE_SHORT_ANSWER_PRESENT" : "MANUALLY_GRADED_COMPLETE";
  const overallReasonDescription = stillPending
    ? "One or more SHORT_ANSWER questions on this submission still need manual grading."
    : "All SHORT_ANSWER questions on this submission have been manually graded; the score is final.";

  await db.query(
    `UPDATE digital_exam_submissions
     SET score=$1, status=$2, needs_review=$3, reason_code=$4, reason_description=$5, score_breakdown=$6, graded_by=$7, graded_at=now()
     WHERE submission_id=$8`,
    [totalScore, newStatus, stillPending, overallReasonCode, overallReasonDescription, JSON.stringify(breakdown), graderUserId, submissionId]
  );

  await logAudit({
    org_id: orgId,
    entity_type: "DIGITAL_EXAM_SUBMISSION",
    entity_id: submissionId,
    agent_or_user: graderUserId,
    action: "DIGITAL_EXAM_SHORT_ANSWER_GRADED",
    reason_code: "SHORT_ANSWER_MANUALLY_GRADED",
    reason_comment: reason,
    output_value: { question_id: questionId, marks_awarded: clampedMarks, new_status: newStatus },
  });
}

// ---------------------------------------------------------------------
// Publishing — the mandatory human approval gate. A DRAFT/
// PENDING_APPROVAL exam can be edited freely; PUBLISHED snapshots the
// full paper into digital_exam_versions for history/rollback.
// ---------------------------------------------------------------------

export async function publishExam(examId: string, orgId: string, actorUserId: string): Promise<void> {
  const paper = await assembleExamPaper(examId, orgId, true);
  if (paper.sections.length === 0 || paper.sections.every((s) => s.questions.length === 0)) {
    throw new Error("Cannot publish an exam with no questions");
  }

  const nextVersion = paper.exam.version;

  await db.withTransaction(async (client) => {
    await client.query(
      `UPDATE digital_exams SET status='PUBLISHED', approved_by=$1, approved_at=now(), updated_at=now() WHERE exam_id=$2`,
      [actorUserId, examId]
    );
    await client.query(
      `INSERT INTO digital_exam_versions (exam_id, version, snapshot, published_by) VALUES ($1,$2,$3,$4)`,
      [examId, nextVersion, JSON.stringify(paper), actorUserId]
    );
  });

  await logAudit({
    org_id: orgId,
    entity_type: "DIGITAL_EXAM",
    entity_id: examId,
    agent_or_user: actorUserId,
    action: "DIGITAL_EXAM_PUBLISHED",
    reason_code: "EXAM_PUBLISHED_HUMAN_APPROVAL",
    reason_comment: `Published as version ${nextVersion} by an authorized reviewer (Admin/Dept Head); full paper snapshotted for rollback.`,
    output_value: { version: nextVersion, section_count: paper.sections.length },
  });
}

// ---------------------------------------------------------------------
// Parsing an uploaded exam paper — deterministic, regex-based, no
// ML/LLM (BYOK: no external AI service required). Word (.docx) papers
// get real text extraction (docx is a ZIP of XML; word/document.xml
// text nodes are extracted and tags stripped). Scanned images are OCR'd
// with tesseract.js, same as parser_agent. PDF binary parsing is not
// implemented in this release — same documented limitation as the MCQ
// Scanner's PDF handling: never guessed, always flagged.
// ---------------------------------------------------------------------

const PDF_NOT_SUPPORTED_MESSAGE =
  "PDF exam paper parsing is not implemented in this release — upload a .docx or a scanned image instead, or convert the PDF externally.";

/** Extracts raw text from a .docx buffer by pulling word/document.xml out of the zip and stripping XML tags. Deterministic, no external service. */
export function extractDocxText(buffer: Buffer): string {
  const zip = new AdmZip(buffer);
  const entry = zip.getEntry("word/document.xml");
  if (!entry) throw new Error("Not a valid .docx file (word/document.xml missing)");
  const xml = entry.getData().toString("utf-8");
  const withBreaks = xml.replace(/<\/w:p>/g, "\n");
  const text = withBreaks
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
  return text;
}

async function runOcr(image: Buffer): Promise<string> {
  const worker = await createWorker("eng");
  try {
    const { data } = await worker.recognize(image);
    return data.text;
  } finally {
    await worker.terminate();
  }
}

/**
 * Deterministic, regex-based question parser. Recognizes lines like:
 *   "Q1. What is ...?" / "1) What is ...?"
 *   "A. option text" / "A) option text" (up to E)
 *   "Answer: A" / "Ans: A" / "Correct Answer: A"
 * A question with 2+ recognized options is MCQ; otherwise SHORT_ANSWER.
 * Confidence is Low whenever an MCQ has no recognized answer-key line —
 * always routed to human review before the exam can be published, never
 * silently trusted.
 */
export function parseExamPaperText(text: string): ParsedQuestionDraft[] {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);

  const questionStart = /^(?:Q\.?\s*)?(\d{1,3})[.)]\s+(.*)$/i;
  const optionLine = /^([A-E])[.)]\s+(.*)$/;
  const answerLine = /^(?:Correct\s+)?(?:Answer|Ans)\s*[-:]\s*([A-E])\b/i;

  const drafts: ParsedQuestionDraft[] = [];
  let current: { text: string; options: { key: string; text: string }[]; answer: string | null } | null = null;

  const flush = () => {
    if (!current) return;
    const isMcq = current.options.length >= 2;
    drafts.push({
      question_type: isMcq ? "MCQ" : "SHORT_ANSWER",
      question_text: current.text.trim(),
      options: isMcq ? current.options : null,
      correct_answer: isMcq ? current.answer : null,
      confidence: isMcq && current.answer ? "High" : "Low",
    });
    current = null;
  };

  for (const line of lines) {
    const qMatch = line.match(questionStart);
    if (qMatch) {
      flush();
      current = { text: qMatch[2], options: [], answer: null };
      continue;
    }
    const optMatch = line.match(optionLine);
    if (optMatch && current) {
      current.options.push({ key: optMatch[1].toUpperCase(), text: optMatch[2].trim() });
      continue;
    }
    const ansMatch = line.match(answerLine);
    if (ansMatch && current) {
      current.answer = ansMatch[1].toUpperCase();
      continue;
    }
    if (current && current.options.length === 0) {
      // Continuation of the question stem (wrapped line before any option/answer seen).
      current.text += " " + line;
    }
  }
  flush();

  return drafts;
}

export interface ParsedPaperResult {
  drafts: ParsedQuestionDraft[];
  source_kind: "docx" | "image" | "unsupported";
  error: string | null;
}

/** Top-level entry point for POST-upload parsing: routes by file type, never throws — an unsupported/failed parse returns an empty draft list with `error` set so the caller can flag it for review instead of crashing. */
export async function parseUploadedExamPaper(filename: string, buffer: Buffer, mimeType: string): Promise<ParsedPaperResult> {
  const lower = filename.toLowerCase();

  if (lower.endsWith(".pdf") || mimeType === "application/pdf") {
    return { drafts: [], source_kind: "unsupported", error: PDF_NOT_SUPPORTED_MESSAGE };
  }

  try {
    if (lower.endsWith(".docx") || mimeType.includes("wordprocessingml")) {
      const text = extractDocxText(buffer);
      return { drafts: parseExamPaperText(text), source_kind: "docx", error: null };
    }
    if (/\.(jpe?g|png)$/i.test(lower) || mimeType.startsWith("image/")) {
      const text = await runOcr(buffer);
      return { drafts: parseExamPaperText(text), source_kind: "image", error: null };
    }
    if (lower.endsWith(".txt") || mimeType === "text/plain") {
      return { drafts: parseExamPaperText(buffer.toString("utf-8")), source_kind: "docx", error: null };
    }
    return { drafts: [], source_kind: "unsupported", error: `Unsupported file type for exam paper parsing: ${filename}` };
  } catch (err) {
    return { drafts: [], source_kind: "unsupported", error: err instanceof Error ? err.message : String(err) };
  }
}

// ---------------------------------------------------------------------
// Export — deterministic document generation from the assembled paper.
// No template rendering AI, no layout guessing: the same paper always
// produces byte-for-byte the same structure (timestamps aside). `pdf`
// and `interactive_pdf` share the same generator here (the "interactive"
// distinction — fillable form fields — is left as a documented gap; the
// export is a faithful static rendering of the same paper either way,
// never a black-box render).
// ---------------------------------------------------------------------

function renderPdfBuffer(paper: AssembledExamPaper): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 50 });
    const chunks: Buffer[] = [];
    doc.on("data", (c: Buffer) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    doc.fontSize(18).text(paper.exam.title, { align: "center" });
    if (paper.exam.description) doc.moveDown(0.5).fontSize(11).text(paper.exam.description, { align: "center" });
    doc.moveDown(0.5).fontSize(10).text(
      [
        paper.exam.date ? `Date: ${paper.exam.date}` : null,
        paper.exam.duration_minutes ? `Duration: ${paper.exam.duration_minutes} min` : null,
        `Total Marks: ${paper.exam.total_marks}`,
      ]
        .filter(Boolean)
        .join("   |   "),
      { align: "center" }
    );
    doc.moveDown(1);

    for (const section of paper.sections) {
      doc.fontSize(14).text(section.section_name, { underline: true });
      doc.moveDown(0.5);
      for (const q of section.questions) {
        doc.fontSize(11).text(`${q.order_index}. ${q.question_text}  [${q.marks} marks]`);
        if (q.question_type === "MCQ" && q.options) {
          for (const opt of q.options) {
            doc.fontSize(10).text(`   ${opt.key}. ${opt.text}`);
          }
        } else {
          doc.fontSize(10).text("   ____________________________________________");
        }
        doc.moveDown(0.5);
      }
      doc.moveDown(0.5);
    }

    doc.end();
  });
}

async function renderDocxBuffer(paper: AssembledExamPaper): Promise<Buffer> {
  const children: Paragraph[] = [
    new Paragraph({ text: paper.exam.title, heading: HeadingLevel.TITLE }),
  ];
  if (paper.exam.description) children.push(new Paragraph({ text: paper.exam.description }));
  children.push(
    new Paragraph({
      children: [
        new TextRun(
          [
            paper.exam.date ? `Date: ${paper.exam.date}` : null,
            paper.exam.duration_minutes ? `Duration: ${paper.exam.duration_minutes} min` : null,
            `Total Marks: ${paper.exam.total_marks}`,
          ]
            .filter(Boolean)
            .join("   |   ")
        ),
      ],
    })
  );

  for (const section of paper.sections) {
    children.push(new Paragraph({ text: section.section_name, heading: HeadingLevel.HEADING_1 }));
    for (const q of section.questions) {
      children.push(new Paragraph({ text: `${q.order_index}. ${q.question_text}  [${q.marks} marks]` }));
      if (q.question_type === "MCQ" && q.options) {
        for (const opt of q.options) {
          children.push(new Paragraph({ text: `   ${opt.key}. ${opt.text}` }));
        }
      } else {
        children.push(new Paragraph({ text: "   ____________________________________________" }));
      }
    }
  }

  const doc = new Document({ sections: [{ children }] });
  return Packer.toBuffer(doc);
}

export interface ExportResult {
  format: ExportFormat;
  contentType: string;
  filename: string;
  buffer: Buffer | null; // null for "link" format
  link: string | null; // set for "link" format
}

/**
 * Exports an assembled (candidate-facing, answers stripped) paper in the
 * requested format. `link` doesn't render a document at all — it
 * returns a stable, guessable-but-authenticated digital exam URL for
 * the Communication Hub to share, consistent with "Communication Hub
 * can share digital exam links or admit cards" in the Master Feature Doc.
 */
export async function exportExamPaper(examId: string, orgId: string, format: ExportFormat, publicBaseUrl: string): Promise<ExportResult> {
  const paper = await assembleExamPaper(examId, orgId, false);
  const safeTitle = paper.exam.title.replace(/[^a-zA-Z0-9._-]/g, "_");

  if (format === "link") {
    return { format, contentType: "text/plain", filename: "", buffer: null, link: `${publicBaseUrl}/exams/${examId}/take` };
  }

  if (format === "docx") {
    const buffer = await renderDocxBuffer(paper);
    return {
      format,
      contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      filename: `${safeTitle}.docx`,
      buffer,
      link: null,
    };
  }

  // pdf and interactive_pdf
  const buffer = await renderPdfBuffer(paper);
  return { format, contentType: "application/pdf", filename: `${safeTitle}.pdf`, buffer, link: null };
}

