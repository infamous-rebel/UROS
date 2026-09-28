import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

vi.mock("../api/client", () => ({
  getToken: () => "dev-token",
  API_V1: "http://localhost:3000/api/v1",
  authedRequest: vi.fn(),
}));

vi.mock("../api/hooks_hr", () => ({
  usePersonas: () => ({ data: { personas: [{ persona_id: "persona-1", name: "Relationship Manager" }], count: 1 } }),
}));

const saveMutate = vi.fn();
const publishMutate = vi.fn();
const parseMutateAsync = vi.fn();
const scoreMutate = vi.fn();
const gradeMutate = vi.fn();

const mockExamResultsData = {
  data: {
    exam: { exam_id: "exam-1", title: "Sample Exam" },
    count: 1,
    submissions: [
      {
        submission_id: "sub-1",
        exam_id: "exam-1",
        candidate_id: "UROS-2026-0001",
        answers: [],
        score: 2,
        status: "NEEDS_REVIEW",
        needs_review: true,
        reason_code: "PENDING_MANUAL_GRADE_SHORT_ANSWER_PRESENT",
        reason_description: "This submission includes one or more SHORT_ANSWER questions.",
        score_breakdown: [
          {
            question_id: "q1",
            question_type: "MCQ",
            reason_code: "MCQ_CORRECT_MATCH",
            reason_description: 'Submitted answer "B" matches the configured correct answer "B".',
            evidence: {
              question_text: "What is 2+2?",
              submitted_answer: "B",
              correct_answer: "B",
              marks_available: 2,
              negative_mark: 0.5,
              rule_applied: "Exact case-insensitive match.",
            },
            marks_awarded: 2,
            outcome: "CORRECT",
          },
        ],
        graded_by: null,
        graded_at: null,
        submitted_at: new Date().toISOString(),
      },
    ],
    status_counts: [{ status: "NEEDS_REVIEW", count: 1 }],
  },
  isLoading: false,
};

vi.mock("../hooks/hooks_exams", () => ({
  useExamList: () => ({ data: { exams: [{ exam_id: "exam-1", title: "Sample Exam", status: "PUBLISHED" }], count: 1 } }),
  useExamPaper: () => ({ data: undefined }),
  useSaveExam: () => ({ mutate: saveMutate, isPending: false, isError: false, error: null }),
  usePublishExam: () => ({ mutate: publishMutate, isPending: false }),
  useParseExamPaper: () => ({ mutateAsync: parseMutateAsync, isPending: false, data: undefined }),
  useExamResults: () => mockExamResultsData,
  useScoreSubmission: () => ({ mutate: scoreMutate }),
  useGradeSubmission: () => ({ mutate: gradeMutate }),
  downloadExamExport: vi.fn(),
}));

import { DigitalExamBuilder } from "./DigitalExamBuilder";

describe("DigitalExamBuilder", () => {
  beforeEach(() => {
    saveMutate.mockClear();
    publishMutate.mockClear();
    parseMutateAsync.mockClear();
    scoreMutate.mockClear();
    gradeMutate.mockClear();
  });

  it("renders the guided builder with exam picker, title input, and persona selector", () => {
    render(<DigitalExamBuilder />);

    expect(screen.getByPlaceholderText(/Exam title/i)).toBeInTheDocument();
    expect(screen.getByText(/Sample Exam \(PUBLISHED\)/i)).toBeInTheDocument();
    expect(screen.getByText(/Relationship Manager/i)).toBeInTheDocument();
  });

  it("adds a section and a question, reflecting them in the live preview", () => {
    render(<DigitalExamBuilder />);

    fireEvent.change(screen.getByPlaceholderText(/Exam title/i), { target: { value: "New Screening Exam" } });
    fireEvent.click(screen.getByText("+ Add section"));

    const sectionNameInput = screen.getByDisplayValue("New Section");
    fireEvent.change(sectionNameInput, { target: { value: "General Knowledge" } });

    fireEvent.click(screen.getByText("+ Add question"));
    const questionTextInput = screen.getByPlaceholderText(/Question text/i);
    fireEvent.change(questionTextInput, { target: { value: "What is the capital of Bangladesh?" } });

    expect(screen.getByText(/Live Preview/i)).toBeInTheDocument();
    expect(screen.getByText("New Screening Exam")).toBeInTheDocument();
    expect(screen.getByText(/What is the capital of Bangladesh\?/)).toBeInTheDocument();
  });

  it("enables Create Exam only once a title and at least one section exist", () => {
    render(<DigitalExamBuilder />);

    const createButton = screen.getByText("Create Exam");
    expect(createButton).toBeDisabled();

    fireEvent.change(screen.getByPlaceholderText(/Exam title/i), { target: { value: "New Screening Exam" } });
    fireEvent.click(screen.getByText("+ Add section"));

    expect(createButton).not.toBeDisabled();
    fireEvent.click(createButton);
    expect(saveMutate).toHaveBeenCalled();
  });

  it("shows submissions with a Why? link revealing reason_code, reason_description, and per-question evidence", () => {
    render(<DigitalExamBuilder />);

    fireEvent.change(screen.getAllByRole("combobox")[0], { target: { value: "exam-1" } });

    expect(screen.getByText(/Submissions & Results/i)).toBeInTheDocument();
    expect(screen.getByText("UROS-2026-0001")).toBeInTheDocument();

    fireEvent.click(screen.getByText("Details"));
    const whyLinks = screen.getAllByText(/Why\?/);
    fireEvent.click(whyLinks[0]);

    expect(screen.getByText(/PENDING_MANUAL_GRADE_SHORT_ANSWER_PRESENT/)).toBeInTheDocument();
  });
});
