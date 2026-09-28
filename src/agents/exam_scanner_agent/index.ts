import { Jimp } from "jimp";
import AdmZip from "adm-zip";
import fs from "fs/promises";
import path from "path";
import { db } from "../../database/client";
import { logAudit } from "../../utils/audit_helper";
import { env } from "../../config/env.schema";
import { logger } from "../../utils/logger";
import {
  AnswerSheetTemplate,
  McqOption,
  McqSheetAnswerStatus,
  OptionDensityReading,
  QuestionDetectionResult,
  SheetDetectionResult,
  McqScoringOutput,
} from "../../models/mcq.model";

/** Density above which an option/digit box is considered marked at all. */
const MARK_DENSITY_THRESHOLD = 0.35;
/** Minimum density gap between the top and second-best option to count as unambiguous. */
const CONFIDENT_SEPARATION = 0.15;

// ---------------------------------------------------------------------
// Preprocessing — deterministic, no ML. "Auto-rotate" and "de-skew" are
// intentionally conservative here: without a reliable fiducial-marker
// detector (out of scope for this feature), blindly rotating a sheet
// risks silently corrupting every downstream reading. Shadow removal
// (normalize + contrast) is a real, deterministic pixel operation that
// measurably helps mark-density sampling and carries no such risk, so
// it is always applied. Rotation/de-skew are wired as explicit,
// clearly-labeled no-op hooks so a future fiducial-marker-based
// implementation has a single place to land. This is stated once, here,
// rather than silently claiming full auto-rotate/de-skew support.
// ---------------------------------------------------------------------

async function rotateAndDeskew(image: Awaited<ReturnType<typeof Jimp.fromBuffer>>) {
  // Stub hook: a real implementation would detect the sheet's four
  // corner fiducial marks (or its outer border) and apply an affine
  // correction. Without that, blind rotation is a guess — and UROS
  // never guesses. No-op today; identity transform.
  return image;
}

async function removeShadowsAndNormalize(image: Awaited<ReturnType<typeof Jimp.fromBuffer>>) {
  // Real, deterministic operations: greyscale flattens color-scanner
  // noise, normalize() stretches contrast to the full 0-255 range
  // (compensating for uneven lighting/shadow), contrast() sharpens the
  // separation between blank paper and ink/pencil marks.
  image.greyscale();
  image.normalize();
  image.contrast(0.3);
  return image;
}

export async function preprocessImage(buffer: Buffer) {
  let image = await Jimp.fromBuffer(buffer);
  image = await rotateAndDeskew(image);
  image = await removeShadowsAndNormalize(image);
  return image;
}

// ---------------------------------------------------------------------
// Mark-density sampling — the deterministic "OMR/handwritten-mark"
// detector. A filled bubble, a ticked/crossed checkbox, and a circled
// letter all share one property: they increase the fraction of dark
// pixels inside that option's zone relative to a blank zone. Sampling
// that fraction is deterministic, auditable, and covers all three mark
// styles uniformly without any model.
// ---------------------------------------------------------------------

function darkPixelFraction(
  image: Awaited<ReturnType<typeof Jimp.fromBuffer>>,
  zone: { x: number; y: number; width: number; height: number }
): number {
  const w = image.width;
  const h = image.height;
  const x0 = Math.max(0, Math.round(zone.x * w));
  const y0 = Math.max(0, Math.round(zone.y * h));
  const x1 = Math.min(w, Math.round((zone.x + zone.width) * w));
  const y1 = Math.min(h, Math.round((zone.y + zone.height) * h));

  let darkPixels = 0;
  let totalPixels = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const rgba = image.getPixelColor(x, y);
      const grey = (rgba >>> 24) & 0xff; // after greyscale(), R=G=B; top byte is R
      if (grey < 128) darkPixels++;
      totalPixels++;
    }
  }
  return totalPixels > 0 ? darkPixels / totalPixels : 0;
}

function pickBestReading(
  readings: OptionDensityReading[]
): { option: McqOption | null; confidence: number; status: McqSheetAnswerStatus } {
  const sorted = [...readings].sort((a, b) => b.density - a.density);
  const best = sorted[0];
  const secondBest = sorted[1];

  if (!best || best.density < MARK_DENSITY_THRESHOLD) {
    // Nothing dark enough to be a mark — a confidently blank/skipped answer.
    return { option: null, confidence: best ? 1 - best.density : 1, status: "MISSING" };
  }

  const marked = readings.filter((r) => r.density >= MARK_DENSITY_THRESHOLD);
  if (marked.length > 1 && secondBest && best.density - secondBest.density < CONFIDENT_SEPARATION) {
    return { option: null, confidence: 1 - (best.density - secondBest.density), status: "MULTIPLE_MARKS" };
  }

  const separation = secondBest ? best.density - secondBest.density : best.density;
  const confidence = Math.max(0, Math.min(1, separation));
  if (confidence < CONFIDENT_SEPARATION) {
    return { option: best.option, confidence, status: "LOW_CONFIDENCE" };
  }
  return { option: best.option, confidence, status: "DETECTED" };
}

export function detectRollNo(
  image: Awaited<ReturnType<typeof Jimp.fromBuffer>>,
  template: AnswerSheetTemplate
): { roll_no: string | null; confidence: number } {
  const digits: string[] = [];
  const confidences: number[] = [];

  for (const column of template.roll_zone.digit_columns) {
    const readings: Array<{ digit: string; density: number }> = [];
    for (let digit = 0; digit <= 9; digit++) {
      const zone = {
        x: column.x,
        y: column.y + digit * template.roll_zone.digit_option_height,
        width: column.width,
        height: template.roll_zone.digit_option_height,
      };
      readings.push({ digit: String(digit), density: darkPixelFraction(image, zone) });
    }
    const sorted = [...readings].sort((a, b) => b.density - a.density);
    const best = sorted[0];
    if (!best || best.density < MARK_DENSITY_THRESHOLD) {
      return { roll_no: null, confidence: 0 };
    }
    digits.push(best.digit);
    const secondBest = sorted[1];
    confidences.push(secondBest ? Math.max(0, best.density - secondBest.density) : best.density);
  }

  return {
    roll_no: digits.join(""),
    confidence: confidences.length ? Math.min(...confidences) : 0,
  };
}

export function detectQuestionAnswers(
  image: Awaited<ReturnType<typeof Jimp.fromBuffer>>,
  template: AnswerSheetTemplate
): QuestionDetectionResult[] {
  return template.question_zones.map((q) => {
    const readings: OptionDensityReading[] = q.options.map((opt) => ({
      option: opt.option,
      density: darkPixelFraction(image, opt),
    }));
    const { option, confidence, status } = pickBestReading(readings);
    return { question_no: q.question_no, detected_option: option, confidence, status, readings };
  });
}

export async function detectSheet(buffer: Buffer, template: AnswerSheetTemplate): Promise<SheetDetectionResult> {
  const image = await preprocessImage(buffer);
  const roll = detectRollNo(image, template);
  const questions = detectQuestionAnswers(image, template);
  return { roll_no: roll.roll_no, roll_detection_confidence: roll.confidence, questions };
}

// ---------------------------------------------------------------------
// Scoring — pure and deterministic, no image/DB dependency. Given a set
// of (possibly human-corrected) answers and an answer key, computes the
// exact same score every time. This is the function unit-tested in
// isolation.
// ---------------------------------------------------------------------

export interface ScoredAnswerInput {
  question_no: number;
  detected_option: McqOption | null;
  status: McqSheetAnswerStatus;
  corrected_option?: McqOption | null;
}

export interface ScoringExamConfig {
  total_questions: number;
  marks_per_question: number;
  negative_mark: number;
  pass_threshold: number | null;
}

export function scoreSheet(
  answers: ScoredAnswerInput[],
  answerKey: Record<number, McqOption>,
  exam: ScoringExamConfig
): McqScoringOutput {
  let correct = 0;
  let wrong = 0;
  let skipped = 0;
  let negativeTotal = 0;
  let needsReview = false;

  const byQuestion = new Map(answers.map((a) => [a.question_no, a]));

  for (let qNo = 1; qNo <= exam.total_questions; qNo++) {
    const answer = byQuestion.get(qNo);
    const key = answerKey[qNo];

    if (!key) {
      // No configured answer key for this question — a data/config gap,
      // never guessed past. Counted as skipped for scoring purposes and
      // always flagged.
      skipped++;
      needsReview = true;
      continue;
    }

    if (!answer) {
      // Sheet has no detection row at all for this question — treat like
      // a missing/unreadable answer rather than silently ignoring it.
      skipped++;
      needsReview = true;
      continue;
    }

    const effectiveOption = answer.corrected_option ?? answer.detected_option;

    if (answer.status === "MULTIPLE_MARKS" || answer.status === "LOW_CONFIDENCE") {
      // Ambiguous detection not yet resolved by a human — score as
      // skipped (never guess), and always surface for review.
      skipped++;
      needsReview = true;
      continue;
    }

    if (effectiveOption === null || effectiveOption === undefined) {
      // Confidently blank (candidate skipped the question) — no penalty,
      // no review needed.
      skipped++;
      continue;
    }

    if (effectiveOption === key) {
      correct++;
    } else {
      wrong++;
      negativeTotal += exam.negative_mark;
    }
  }

  const finalScore = Math.round((correct * exam.marks_per_question - negativeTotal) * 100) / 100;
  const passed =
    exam.pass_threshold !== null && exam.pass_threshold !== undefined ? finalScore >= exam.pass_threshold : null;

  return {
    correct_count: correct,
    wrong_count: wrong,
    skipped_count: skipped,
    negative_total: Math.round(negativeTotal * 100) / 100,
    final_score: finalScore,
    passed,
    needs_review: needsReview,
  };
}

// ---------------------------------------------------------------------
// Orchestration — file handling (PDF/JPG/PNG/ZIP), persistence, audit.
// ---------------------------------------------------------------------

export interface IngestedFile {
  filename: string;
  buffer: Buffer;
  mimeType: string;
}

/** Expands a single upload (image, PDF, or ZIP of images) into individual page/image files. PDFs pass through unrasterized (see module docstring on scope). */
export function expandUpload(filename: string, buffer: Buffer, mimeType: string): IngestedFile[] {
  const lower = filename.toLowerCase();

  if (lower.endsWith(".zip") || mimeType === "application/zip") {
    const zip = new AdmZip(buffer);
    const entries = zip.getEntries().filter((e) => !e.isDirectory);
    return entries
      .filter((e) => /\.(jpe?g|png|pdf)$/i.test(e.entryName))
      .map((e) => ({
        filename: e.entryName,
        buffer: e.getData(),
        mimeType: /\.pdf$/i.test(e.entryName) ? "application/pdf" : "image/jpeg",
      }));
  }

  return [{ filename, buffer, mimeType }];
}

async function storeSheetFile(orgId: string, examId: string, filename: string, buffer: Buffer): Promise<string> {
  const dir = path.join(env.DOCUMENT_STORAGE_PATH, "mcq", orgId, examId);
  await fs.mkdir(dir, { recursive: true }).catch(() => undefined);
  const safeName = `${Date.now()}-${filename.replace(/[^a-zA-Z0-9._-]/g, "_")}`;
  const fullPath = path.join(dir, safeName);
  try {
    await fs.writeFile(fullPath, buffer);
  } catch (err) {
    // Storage failures must not crash an upload batch — the sheet row
    // still gets created (status NEEDS_REVIEW, processing_error set) so
    // nothing is silently lost; an operator can re-upload.
    logger.error("MCQ_SHEET_STORAGE_FAILED", { error: err instanceof Error ? err.message : String(err), fullPath });
  }
  return fullPath;
}

async function loadExamById(examId: string) {
  const examRes = await db.query(`SELECT * FROM mcq_exams WHERE exam_id=$1`, [examId]);
  if (examRes.rowCount === 0) throw new Error(`Exam not found: ${examId}`);
  const exam = examRes.rows[0];

  const keyRes = await db.query(
    `SELECT question_no, correct_option FROM mcq_answer_keys WHERE exam_id=$1 AND active=true`,
    [examId]
  );
  const answerKey: Record<number, McqOption> = {};
  for (const row of keyRes.rows) answerKey[row.question_no] = row.correct_option;

  return { exam, answerKey };
}

/**
 * Processes one already-persisted mcq_answer_sheets row end-to-end:
 * detect -> persist mcq_sheet_answers -> score -> upsert mcq_results ->
 * update sheet status -> audit. Never throws past this point for a
 * single sheet — a processing failure is recorded on the sheet
 * (NEEDS_REVIEW + processing_error) so the rest of a batch is unaffected.
 */
export async function processSheet(sheetId: string, actorUserId: string): Promise<void> {
  const sheetRes = await db.query(`SELECT * FROM mcq_answer_sheets WHERE sheet_id=$1`, [sheetId]);
  if (sheetRes.rowCount === 0) throw new Error(`Sheet not found: ${sheetId}`);
  const sheet = sheetRes.rows[0];

  try {
    const { exam, answerKey } = await loadExamById(sheet.exam_id);

    if (!exam.answer_sheet_template) {
      throw new Error("Exam has no answer_sheet_template configured — configure it via POST /mcq/configure first");
    }

    const buffer = await fs.readFile(sheet.file_path);
    const detection = await detectSheet(buffer, exam.answer_sheet_template as AnswerSheetTemplate);

    await db.withTransaction(async (client) => {
      await client.query(`DELETE FROM mcq_sheet_answers WHERE sheet_id=$1`, [sheetId]);
      for (const q of detection.questions) {
        await client.query(
          `INSERT INTO mcq_sheet_answers (sheet_id, question_no, detected_option, confidence, status)
           VALUES ($1,$2,$3,$4,$5)`,
          [sheetId, q.question_no, q.detected_option, q.confidence, q.status]
        );
      }

      const scoring = scoreSheet(
        detection.questions.map((q) => ({
          question_no: q.question_no,
          detected_option: q.detected_option,
          status: q.status,
        })),
        answerKey,
        {
          total_questions: exam.total_questions,
          marks_per_question: Number(exam.marks_per_question),
          negative_mark: Number(exam.negative_mark),
          pass_threshold: exam.pass_threshold !== null ? Number(exam.pass_threshold) : null,
        }
      );

      const rollAmbiguous =
        detection.roll_detection_confidence !== null && detection.roll_detection_confidence < CONFIDENT_SEPARATION;
      const overallNeedsReview = scoring.needs_review || rollAmbiguous || !detection.roll_no;
      const newStatus = overallNeedsReview ? "NEEDS_REVIEW" : "PROCESSED";

      await client.query(
        `UPDATE mcq_answer_sheets SET status=$1, roll_no=$2, roll_detection_confidence=$3, processed_at=now(), processing_error=NULL
         WHERE sheet_id=$4`,
        [newStatus, detection.roll_no, detection.roll_detection_confidence, sheetId]
      );

      await client.query(
        `INSERT INTO mcq_results (sheet_id, candidate_id, correct_count, wrong_count, skipped_count, negative_total, final_score, passed, needs_review)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT (sheet_id) DO UPDATE SET
           candidate_id=EXCLUDED.candidate_id, correct_count=EXCLUDED.correct_count, wrong_count=EXCLUDED.wrong_count,
           skipped_count=EXCLUDED.skipped_count, negative_total=EXCLUDED.negative_total, final_score=EXCLUDED.final_score,
           passed=EXCLUDED.passed, needs_review=EXCLUDED.needs_review`,
        [
          sheetId,
          sheet.candidate_id,
          scoring.correct_count,
          scoring.wrong_count,
          scoring.skipped_count,
          scoring.negative_total,
          scoring.final_score,
          scoring.passed,
          overallNeedsReview,
        ]
      );
    });

    await logAudit({
      entity_type: "MCQ_SHEET",
      entity_id: sheetId,
      agent_or_user: actorUserId,
      action: "MCQ_SHEET_PROCESSED",
      output_value: {
        roll_no: detection.roll_no,
        needs_review: detection.questions.some((q) => q.status !== "DETECTED" && q.status !== "MISSING"),
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await db.query(
      `UPDATE mcq_answer_sheets SET status='NEEDS_REVIEW', processing_error=$1, processed_at=now() WHERE sheet_id=$2`,
      [message, sheetId]
    );
    await logAudit({
      entity_type: "MCQ_SHEET",
      entity_id: sheetId,
      agent_or_user: actorUserId,
      action: "MCQ_SHEET_PROCESSING_FAILED",
      reason_comment: message,
    });
  }
}

/**
 * Ingests one uploaded file (already possibly ZIP-expanded by the
 * caller into individual page files) as a new mcq_answer_sheets row,
 * stores it, and immediately runs processSheet. PDFs are stored but not
 * rasterized (see module docstring) — flagged NEEDS_REVIEW with a clear
 * processing_error instead of guessing or crashing.
 */
export async function ingestSheetFile(
  examId: string,
  orgId: string,
  file: IngestedFile,
  actorUserId: string
): Promise<string> {
  const filePath = await storeSheetFile(orgId, examId, file.filename, file.buffer);

  const isPdf = file.mimeType === "application/pdf" || file.filename.toLowerCase().endsWith(".pdf");

  const insertRes = await db.query(
    `INSERT INTO mcq_answer_sheets (exam_id, file_path, status, processing_error)
     VALUES ($1,$2,$3,$4) RETURNING sheet_id`,
    [
      examId,
      filePath,
      isPdf ? "NEEDS_REVIEW" : "UPLOADED",
      isPdf
        ? "PDF page rasterization is not implemented in this release — upload JPG/PNG pages instead, or split the PDF externally."
        : null,
    ]
  );
  const sheetId = insertRes.rows[0].sheet_id as string;

  await logAudit({
    entity_type: "MCQ_SHEET",
    entity_id: sheetId,
    agent_or_user: actorUserId,
    action: "MCQ_SHEET_UPLOADED",
    input_value: { exam_id: examId, filename: file.filename },
  });

  if (!isPdf) {
    await processSheet(sheetId, actorUserId);
  }

  return sheetId;
}
