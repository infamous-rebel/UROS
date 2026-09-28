import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { authedRequest, API_V1, getToken } from "../api/client";

const enabled = () => !!getToken();

export type ExamStatus = "DRAFT" | "PENDING_APPROVAL" | "PUBLISHED" | "ARCHIVED";
export type QuestionType = "MCQ" | "SHORT_ANSWER";
export type SubmissionStatus = "SUBMITTED" | "SCORED" | "NEEDS_REVIEW" | "GRADED";

export interface McqOptionDef {
  key: string;
  text: string;
}

export interface ExamQuestion {
  question_id: string;
  section_id: string;
  question_type: QuestionType;
  question_text: string;
  options: McqOptionDef[] | null;
  correct_answer: string | null;
  marks: number;
  negative_mark: number;
  order_index: number;
  source: "MANUAL" | "QUESTION_BANK" | "PARSED";
  bank_question_id: string | null;
}

export interface ExamSection {
  section_id: string;
  exam_id: string;
  section_name: string;
  order_index: number;
  topic: string | null;
  weight: number | null;
  questions: ExamQuestion[];
}

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
  created_at: string;
}

export interface AssembledExamPaper {
  exam: DigitalExam;
  sections: ExamSection[];
}

export interface QuestionEvidence {
  question_text: string;
  submitted_answer: string | null;
  correct_answer: string | null;
  marks_available: number;
  negative_mark: number;
  rule_applied: string;
}

export interface QuestionScoreEvidence {
  question_id: string;
  question_type: QuestionType;
  reason_code: string;
  reason_description: string;
  evidence: QuestionEvidence;
  marks_awarded: number;
  outcome: "CORRECT" | "WRONG" | "SKIPPED" | "PENDING_MANUAL_GRADE";
}

export interface DigitalExamSubmission {
  submission_id: string;
  exam_id: string;
  candidate_id: string | null;
  answers: Array<{ question_id: string; answer: string | null }>;
  score: number | null;
  status: SubmissionStatus;
  needs_review: boolean;
  reason_code: string | null;
  reason_description: string | null;
  score_breakdown: QuestionScoreEvidence[] | null;
  graded_by: string | null;
  graded_at: string | null;
  submitted_at: string;
}

export interface ParsedQuestionDraft {
  question_type: QuestionType;
  question_text: string;
  options: McqOptionDef[] | null;
  correct_answer: string | null;
  confidence: "High" | "Low";
}

/** Exam list for the caller's org — see GET /exams. */
export function useExamList() {
  return useQuery({
    queryKey: ["exam-list"],
    queryFn: () => authedRequest<{ exams: DigitalExam[]; count: number }>(`${API_V1}/exams`),
    enabled: enabled(),
  });
}

/** Reusable question bank — see GET /exams/question-bank. */
export function useQuestionBank(topic?: string) {
  return useQuery({
    queryKey: ["exam-question-bank", topic ?? null],
    queryFn: () =>
      authedRequest<{ questions: any[]; count: number }>(`${API_V1}/exams/question-bank${topic ? `?topic=${encodeURIComponent(topic)}` : ""}`),
    enabled: enabled(),
  });
}

/** Full assembled paper — see GET /exams/:exam_id. */
export function useExamPaper(examId: string | null) {
  return useQuery({
    queryKey: ["exam-paper", examId],
    queryFn: () => authedRequest<{ paper: AssembledExamPaper }>(`${API_V1}/exams/${examId}`),
    enabled: enabled() && !!examId,
  });
}

/** Create or fully update a DRAFT exam paper — see POST /exams. */
export function useSaveExam() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      authedRequest<{ exam: DigitalExam }>(`${API_V1}/exams`, { method: "POST", body: JSON.stringify(body) }),
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ["exam-list"] });
      qc.invalidateQueries({ queryKey: ["exam-paper", data.exam.exam_id] });
    },
  });
}

/** Publish (human approval gate) — see POST /exams/:exam_id/publish. */
export function usePublishExam() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (examId: string) => authedRequest<{ exam: DigitalExam }>(`${API_V1}/exams/${examId}/publish`, { method: "POST" }),
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ["exam-list"] });
      qc.invalidateQueries({ queryKey: ["exam-paper", data.exam.exam_id] });
    },
  });
}

/** Uploads a paper (.docx/image/.txt) and returns deterministic parsed drafts for review — see POST /exams/parse. */
export function useParseExamPaper() {
  return useMutation({
    mutationFn: async (file: File) => {
      const token = getToken();
      const form = new FormData();
      form.append("file", file);
      const res = await fetch(`${API_V1}/exams/parse`, {
        method: "POST",
        headers: token ? { Authorization: `Bearer ${token}` } : undefined,
        body: form,
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok && res.status !== 422) throw new Error(body.error ?? `Parse failed with status ${res.status}`);
      return body as { drafts: ParsedQuestionDraft[]; source_kind: string; error: string | null };
    },
  });
}

/** Exam-level submissions + status counts — see GET /exams/:exam_id/results. */
export function useExamResults(examId: string | null) {
  return useQuery({
    queryKey: ["exam-results", examId],
    queryFn: () =>
      authedRequest<{ exam: DigitalExam; submissions: DigitalExamSubmission[]; count: number; status_counts: Array<{ status: SubmissionStatus; count: number }> }>(
        `${API_V1}/exams/${examId}/results`
      ),
    enabled: enabled() && !!examId,
  });
}

/** Triggers deterministic MCQ scoring of a submission — see POST /exams/:exam_id/score. */
export function useScoreSubmission(examId: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (submissionId: string) =>
      authedRequest<{ scoring: unknown }>(`${API_V1}/exams/${examId}/score`, { method: "POST", body: JSON.stringify({ submission_id: submissionId }) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["exam-results", examId] }),
  });
}

/** Human grading of a SHORT_ANSWER question — mandatory reason — see PATCH .../submissions/:submission_id/grade. */
export function useGradeSubmission(examId: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      submissionId,
      questionId,
      marksAwarded,
      reason,
    }: {
      submissionId: string;
      questionId: string;
      marksAwarded: number;
      reason: string;
    }) =>
      authedRequest<{ submission: DigitalExamSubmission }>(`${API_V1}/exams/${examId}/submissions/${submissionId}/grade`, {
        method: "PATCH",
        body: JSON.stringify({ question_id: questionId, marks_awarded: marksAwarded, reason }),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["exam-results", examId] }),
  });
}

/** Downloads an export (pdf/docx/interactive_pdf) or fetches a shareable link — see GET /exams/:exam_id/export. */
export async function downloadExamExport(examId: string, format: "pdf" | "docx" | "interactive_pdf" | "link"): Promise<{ link?: string }> {
  const token = getToken();
  const res = await fetch(`${API_V1}/exams/${examId}/export?format=${format}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `Export failed with status ${res.status}`);
  }
  if (format === "link") {
    return res.json();
  }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `exam-${examId}.${format === "docx" ? "docx" : "pdf"}`;
  a.click();
  URL.revokeObjectURL(url);
  return {};
}
