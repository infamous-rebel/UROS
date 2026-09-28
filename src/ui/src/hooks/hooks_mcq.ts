import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { authedRequest, API_V1, getToken } from "../api/client";

const enabled = () => !!getToken();

export type McqSheetStatus =
  | "UPLOADED"
  | "PROCESSING"
  | "PROCESSED"
  | "NEEDS_REVIEW"
  | "CONFIRMED"
  | "REJECTED"
  | "RESCAN_REQUESTED";

export interface McqExam {
  exam_id: string;
  org_id: string;
  name: string;
  date: string | null;
  total_questions: number;
  marks_per_question: number;
  negative_mark: number;
  pass_threshold: number | null;
  answer_sheet_template: unknown;
  created_at: string;
}

export interface McqAnswerSheet {
  sheet_id: string;
  exam_id: string;
  candidate_id: string | null;
  roll_no: string | null;
  file_path: string;
  status: McqSheetStatus;
  roll_detection_confidence: number | null;
  processing_error: string | null;
  reviewed_by: string | null;
  review_reason: string | null;
  uploaded_at: string;
  processed_at: string | null;
  reviewed_at: string | null;
}

export interface McqSheetAnswer {
  sheet_answer_id: string;
  sheet_id: string;
  question_no: number;
  detected_option: "A" | "B" | "C" | "D" | "E" | null;
  confidence: number;
  status: "DETECTED" | "LOW_CONFIDENCE" | "MULTIPLE_MARKS" | "MISSING" | "CORRECTED";
  corrected_option: "A" | "B" | "C" | "D" | "E" | null;
}

export interface McqResult {
  result_id: string;
  sheet_id: string;
  candidate_id: string | null;
  correct_count: number;
  wrong_count: number;
  skipped_count: number;
  negative_total: number;
  final_score: number;
  passed: boolean | null;
  needs_review: boolean;
}

/** Exam-level scorecard: every sheet's result plus status counts — see GET /mcq/results/:exam_id. */
export function useMcqResults(examId: string | null) {
  return useQuery({
    queryKey: ["mcq-results", examId],
    queryFn: () =>
      authedRequest<{
        exam: McqExam;
        results: Array<McqResult & { sheet_status: McqSheetStatus; roll_no: string | null }>;
        count: number;
        status_counts: Array<{ status: McqSheetStatus; count: number }>;
      }>(`${API_V1}/mcq/results/${examId}`),
    enabled: enabled() && !!examId,
  });
}

/** Full sheet detail (evidence panel) — see GET /mcq/sheets/:sheet_id. */
export function useMcqSheetDetail(sheetId: string | null) {
  return useQuery({
    queryKey: ["mcq-sheet", sheetId],
    queryFn: () =>
      authedRequest<{ sheet: McqAnswerSheet; answers: McqSheetAnswer[]; result: McqResult | null }>(
        `${API_V1}/mcq/sheets/${sheetId}`
      ),
    enabled: enabled() && !!sheetId,
  });
}

/** Upload one file (JPG/PNG/PDF/ZIP) for an exam — multipart, bypasses the JSON-only authedRequest helper. */
export function useUploadMcqSheets(examId: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (file: File) => {
      const token = getToken();
      const form = new FormData();
      form.append("exam_id", examId ?? "");
      form.append("file", file);
      const res = await fetch(`${API_V1}/mcq/upload`, {
        method: "POST",
        headers: token ? { Authorization: `Bearer ${token}` } : undefined,
        body: form,
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? `Upload failed with status ${res.status}`);
      }
      return res.json() as Promise<{ sheets: McqAnswerSheet[]; count: number }>;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["mcq-results", examId] }),
  });
}

/** Human review of a sheet: CONFIRM / CORRECT / REJECT / RESCAN, mandatory reason — see PATCH /mcq/sheets/:sheet_id. */
export function useReviewMcqSheet(examId: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      sheetId,
      action,
      reason,
      rollNo,
      corrections,
    }: {
      sheetId: string;
      action: "CONFIRM" | "CORRECT" | "REJECT" | "RESCAN";
      reason: string;
      rollNo?: string;
      corrections?: Array<{ question_no: number; corrected_option: "A" | "B" | "C" | "D" | "E" | null }>;
    }) =>
      authedRequest<{ sheet: McqAnswerSheet }>(`${API_V1}/mcq/sheets/${sheetId}`, {
        method: "PATCH",
        body: JSON.stringify({ action, reason, roll_no: rollNo, corrections }),
      }),
    onSuccess: (_data, variables) => {
      qc.invalidateQueries({ queryKey: ["mcq-results", examId] });
      qc.invalidateQueries({ queryKey: ["mcq-sheet", variables.sheetId] });
    },
  });
}
