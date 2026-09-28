export type McqOption = "A" | "B" | "C" | "D" | "E";

export interface McqExam {
  exam_id: string;
  org_id: string;
  name: string;
  date: string | null;
  total_questions: number;
  marks_per_question: number;
  negative_mark: number;
  answer_sheet_template: AnswerSheetTemplate | null;
  pass_threshold: number | null;
  created_by: string | null;
  created_at: string;
}

/**
 * Configurable answer sheet layout: pixel-space rectangles used for
 * deterministic mark-density sampling. Coordinates are normalized 0-1
 * fractions of image width/height so the same template works across
 * scans of slightly different resolutions.
 */
export interface AnswerSheetTemplate {
  roll_zone: {
    digit_count: number;
    /** One zone per digit column, each with 10 option boxes (0-9) stacked vertically, normalized 0-1. */
    digit_columns: Array<{ x: number; y: number; width: number; height: number }>;
    digit_option_height: number; // normalized height of each 0-9 box within a digit column
  };
  question_zones: Array<{
    question_no: number;
    options: Array<{ option: McqOption; x: number; y: number; width: number; height: number }>;
  }>;
}

export interface McqAnswerKey {
  answer_key_id: string;
  exam_id: string;
  question_no: number;
  correct_option: McqOption;
  version: number;
  active: boolean;
  created_at: string;
}

export type McqSheetStatus =
  | "UPLOADED"
  | "PROCESSING"
  | "PROCESSED"
  | "NEEDS_REVIEW"
  | "CONFIRMED"
  | "REJECTED"
  | "RESCAN_REQUESTED";

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

export type McqSheetAnswerStatus = "DETECTED" | "LOW_CONFIDENCE" | "MULTIPLE_MARKS" | "MISSING" | "CORRECTED";

export interface McqSheetAnswer {
  sheet_answer_id: string;
  sheet_id: string;
  question_no: number;
  detected_option: McqOption | null;
  confidence: number;
  status: McqSheetAnswerStatus;
  corrected_option: McqOption | null;
  created_at: string;
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
  created_at: string;
}

/** Per-option mark-density reading produced during bubble/mark detection — the evidence behind a detected_option. */
export interface OptionDensityReading {
  option: McqOption;
  density: number; // 0-1, fraction of dark pixels within the option's zone
}

export interface QuestionDetectionResult {
  question_no: number;
  detected_option: McqOption | null;
  confidence: number;
  status: McqSheetAnswerStatus;
  readings: OptionDensityReading[];
}

export interface SheetDetectionResult {
  roll_no: string | null;
  roll_detection_confidence: number | null;
  questions: QuestionDetectionResult[];
}

export interface McqScoringOutput {
  correct_count: number;
  wrong_count: number;
  skipped_count: number;
  negative_total: number;
  final_score: number;
  passed: boolean | null;
  needs_review: boolean;
}
