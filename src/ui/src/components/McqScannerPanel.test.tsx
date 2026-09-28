import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

vi.mock("../api/client", () => ({
  getToken: () => "dev-token",
  API_V1: "http://localhost:3000/api/v1",
  authedRequest: vi.fn(),
}));

const mockResultsData = {
  data: {
    exam: { exam_id: "exam-1", name: "Test Exam", total_questions: 1 },
    count: 1,
    results: [
      {
        sheet_id: "sheet-1",
        sheet_status: "NEEDS_REVIEW",
        roll_no: null,
        candidate_id: null,
        correct_count: 0,
        wrong_count: 0,
        skipped_count: 1,
        negative_total: 0,
        final_score: 0,
        passed: null,
        needs_review: true,
      },
    ],
    status_counts: [{ status: "NEEDS_REVIEW", count: 1 }],
  },
  isLoading: false,
  isError: false,
};

const mockSheetDetail = {
  data: {
    sheet: {
      sheet_id: "sheet-1",
      exam_id: "exam-1",
      candidate_id: null,
      roll_no: null,
      file_path: "/data/uros/documents/mcq/org/exam/sheet-1.png",
      status: "NEEDS_REVIEW",
      roll_detection_confidence: 0.1,
      processing_error: null,
      reviewed_by: null,
      review_reason: null,
    },
    answers: [
      {
        sheet_answer_id: "ans-1",
        sheet_id: "sheet-1",
        question_no: 1,
        detected_option: null,
        confidence: 0.1,
        status: "LOW_CONFIDENCE",
        corrected_option: null,
      },
    ],
    result: {
      result_id: "res-1",
      sheet_id: "sheet-1",
      candidate_id: null,
      correct_count: 0,
      wrong_count: 0,
      skipped_count: 1,
      negative_total: 0,
      final_score: 0,
      passed: null,
      needs_review: true,
    },
  },
  isLoading: false,
};

const uploadMutate = vi.fn();
const reviewMutate = vi.fn();

vi.mock("../hooks/hooks_mcq", () => ({
  useMcqResults: () => mockResultsData,
  useMcqSheetDetail: () => mockSheetDetail,
  useUploadMcqSheets: () => ({ mutate: uploadMutate, isPending: false, isError: false, error: null }),
  useReviewMcqSheet: () => ({ mutate: reviewMutate, isPending: false }),
}));

import { McqScannerPanel } from "./McqScannerPanel";

describe("McqScannerPanel", () => {
  beforeEach(() => {
    uploadMutate.mockClear();
    reviewMutate.mockClear();
  });

  it("prompts for an exam ID before any results are loaded", () => {
    render(<McqScannerPanel />);
    expect(screen.getByPlaceholderText(/Exam ID/i)).toBeInTheDocument();
    expect(screen.getByText(/Enter an Exam ID and Load Exam/i)).toBeInTheDocument();
  });

  it("renders the status strip and results table after loading an exam", () => {
    render(<McqScannerPanel />);

    fireEvent.change(screen.getByPlaceholderText(/Exam ID/i), { target: { value: "exam-1" } });
    fireEvent.click(screen.getByText("Load Exam"));

    expect(screen.getAllByText("NEEDS REVIEW").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("Review")).toBeInTheDocument();
    expect(screen.getByText("Export Scorecard (CSV)")).toBeInTheDocument();
  });

  it("opens the sheet review detail with flagged evidence when Review is clicked", () => {
    render(<McqScannerPanel />);
    fireEvent.change(screen.getByPlaceholderText(/Exam ID/i), { target: { value: "exam-1" } });
    fireEvent.click(screen.getByText("Load Exam"));
    fireEvent.click(screen.getByText("Review"));

    expect(screen.getByText(/Flagged answers/i)).toBeInTheDocument();
    expect(screen.getByText("LOW CONFIDENCE")).toBeInTheDocument();
  });

  it("requires a reason before submitting a Confirm review decision", () => {
    render(<McqScannerPanel />);
    fireEvent.change(screen.getByPlaceholderText(/Exam ID/i), { target: { value: "exam-1" } });
    fireEvent.click(screen.getByText("Load Exam"));
    fireEvent.click(screen.getByText("Review"));

    fireEvent.click(screen.getByText("Confirm"));
    expect(reviewMutate).not.toHaveBeenCalled();
    expect(screen.getByText(/A reason is required/i)).toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText(/Mandatory reason/i), {
      target: { value: "Verified against the original scan" },
    });
    fireEvent.click(screen.getByText("Confirm"));

    expect(reviewMutate).toHaveBeenCalledWith(
      expect.objectContaining({ sheetId: "sheet-1", action: "CONFIRM", reason: "Verified against the original scan" }),
      expect.anything()
    );
  });
});
