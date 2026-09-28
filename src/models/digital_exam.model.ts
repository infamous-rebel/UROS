export type ExamStatus = "DRAFT" | "PENDING_APPROVAL" | "PUBLISHED" | "ARCHIVED";
export type QuestionType = "MCQ" | "SHORT_ANSWER";
export type QuestionSource = "MANUAL" | "QUESTION_BANK" | "PARSED";
export type SubmissionStatus = "SUBMITTED" | "SCORED" | "NEEDS_REVIEW" | "GRADED";

export interface DigitalExam {
  exam_id: string;
  org_id: string;
  title: string;
  description: string | null;
  header_logo: string | null;
  date: string | null;
  duration_minutes: number | null;
  status: ExamStatus;
  version: number;
  persona_id: string | null;
  total_marks: number;
  approved_by: string | null;
  approved_at: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface ExamSection {
  section_id: string;
  exam_id: string;
  section_name: string;
  order_index: number;
  topic: string | null;
  weight: number | null;
}

export interface McqOptionDef {
  key: string; // e.g. "A"
  text: string;
}

export interface ExamQuestion {
  question_id: string;
  section_id: string;
  question_type: QuestionType;
  question_text: string;
  options: McqOptionDef[] | null; // MCQ only
  correct_answer: string | null; // MCQ: option key; SHORT_ANSWER: always null
  marks: number;
  negative_mark: number;
  order_index: number;
  source: QuestionSource;
  bank_question_id: string | null;
}

export interface ExamQuestionBankEntry {
  bank_question_id: string;
  org_id: string;
  question_type: QuestionType;
  question_text: string;
  options: McqOptionDef[] | null;
  correct_answer: string | null;
  marks: number;
  negative_mark: number;
  topic: string | null;
  created_by: string | null;
  created_at: string;
}

/** Full assembled paper: exam + ordered sections + ordered questions. answers/correct_answer are stripped for candidate-facing exports. */
export interface AssembledExamPaper {
  exam: DigitalExam;
  sections: Array<ExamSection & { questions: ExamQuestion[] }>;
}

export interface SubmissionAnswer {
  question_id: string;
  answer: string | null; // MCQ: option key; SHORT_ANSWER: free text (never auto-graded)
}

export interface DigitalExamSubmission {
  submission_id: string;
  exam_id: string;
  candidate_id: string | null;
  answers: SubmissionAnswer[];
  score: number | null;
  status: SubmissionStatus;
  needs_review: boolean;
  reason_code: SubmissionReasonCode | null;
  reason_description: string | null;
  score_breakdown: QuestionScoreEvidence[] | null;
  graded_by: string | null;
  graded_at: string | null;
  submitted_at: string;
}

/** Per-question scoring evidence — the "no black-box" contract: every mark traces to a reason_code, a plain-language reason_description, and structured evidence (question, candidate answer, correct answer, marks, rule applied). */
export interface QuestionScoreEvidence {
  question_id: string;
  question_type: QuestionType;
  reason_code: QuestionReasonCode;
  reason_description: string;
  evidence: QuestionEvidence;
  marks_awarded: number;
  outcome: "CORRECT" | "WRONG" | "SKIPPED" | "PENDING_MANUAL_GRADE";
}

export type QuestionReasonCode =
  | "MCQ_CORRECT_MATCH"
  | "MCQ_WRONG_ANSWER"
  | "MCQ_SKIPPED_NO_ANSWER"
  | "SHORT_ANSWER_PENDING_MANUAL_GRADE"
  | "SHORT_ANSWER_MANUALLY_GRADED";

export interface QuestionEvidence {
  question_text: string;
  submitted_answer: string | null;
  correct_answer: string | null;
  marks_available: number;
  negative_mark: number;
  rule_applied: string; // plain-language description of the exact rule/comparison used
}

export type SubmissionReasonCode =
  | "AUTO_SCORED_ALL_MCQ"
  | "PENDING_MANUAL_GRADE_SHORT_ANSWER_PRESENT"
  | "MANUALLY_GRADED_COMPLETE";

export interface DigitalExamScoringOutput {
  auto_score: number; // sum of MCQ marks_awarded only
  max_marks: number; // sum of all question marks (MCQ + short-answer)
  needs_review: boolean; // true whenever any short-answer question is present/unanswered-manually-graded
  reason_code: SubmissionReasonCode;
  reason_description: string;
  breakdown: QuestionScoreEvidence[];
}

export type ExportFormat = "pdf" | "docx" | "interactive_pdf" | "link";

/** Deterministic, regex-based extraction from an uploaded paper's plain text (OCR'd image or docx-extracted text) — no ML/LLM. */
export interface ParsedQuestionDraft {
  question_type: QuestionType;
  question_text: string;
  options: McqOptionDef[] | null;
  correct_answer: string | null;
  confidence: "High" | "Low"; // Low when an answer key marker wasn't found — always routed to human review before publish
}
