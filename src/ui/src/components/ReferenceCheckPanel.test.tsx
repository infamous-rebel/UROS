import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

vi.mock("../api/client", () => ({
  getToken: () => "dev-token",
  API_V1: "http://localhost:3000/api/v1",
  authedRequest: vi.fn(),
}));

const mockRequestsData = {
  data: {
    requests: [
      {
        request_id: "req-1",
        org_id: "org-1",
        candidate_id: "UROS-2026-000001",
        referee_email: "referee@example.com",
        referee_phone: null,
        persona_id: null,
        question_set_id: "qs-1",
        status: "COMPLETED",
        expires_at: "2026-09-20T00:00:00Z",
        created_at: "2026-09-01T00:00:00Z",
        sent_at: "2026-09-01T00:05:00Z",
        reminder_count: 0,
        completed_at: "2026-09-03T00:00:00Z",
        result_id: "result-1",
        total_score: 82.5,
        max_score: 100,
        recommendation: "RECOMMEND",
        review_decision: null,
        reviewed_at: null,
      },
    ],
    count: 1,
  },
  isLoading: false,
  isError: false,
};

const createMutate = vi.fn();
const scoreMutate = vi.fn();
const reviewMutate = vi.fn();

vi.mock("../hooks/hooks_reference", () => ({
  useReferenceRequests: () => mockRequestsData,
  useCreateReferenceRequest: () => ({ mutate: createMutate, isPending: false, isError: false, error: null, isSuccess: false }),
  useScoreReferenceRequest: () => ({ mutate: scoreMutate, isPending: false }),
  useReviewReferenceResult: () => ({ mutate: reviewMutate, isPending: false, isError: false, error: null }),
}));

import { ReferenceCheckPanel } from "./ReferenceCheckPanel";

describe("ReferenceCheckPanel", () => {
  beforeEach(() => {
    createMutate.mockClear();
    scoreMutate.mockClear();
    reviewMutate.mockClear();
  });

  it("prompts for a candidate ID before showing any requests", () => {
    render(<ReferenceCheckPanel />);
    expect(screen.getByText(/Look up a candidate ID/i)).toBeInTheDocument();
  });

  it("shows requests, scores, and recommendation badge after looking up a candidate", () => {
    render(<ReferenceCheckPanel />);
    fireEvent.change(screen.getByPlaceholderText("Candidate ID"), { target: { value: "UROS-2026-000001" } });
    fireEvent.click(screen.getByText("View Requests"));

    expect(screen.getByText("referee@example.com")).toBeInTheDocument();
    expect(screen.getByText("COMPLETED")).toBeInTheDocument();
    expect(screen.getByText("RECOMMEND")).toBeInTheDocument();
    expect(screen.getByText(/82.5/)).toBeInTheDocument();
  });

  it("sends a new reference request with a referee email", () => {
    render(<ReferenceCheckPanel />);
    fireEvent.change(screen.getByPlaceholderText("Candidate ID"), { target: { value: "UROS-2026-000001" } });
    fireEvent.click(screen.getByText("View Requests"));

    fireEvent.change(screen.getByPlaceholderText("Referee email"), { target: { value: "newref@example.com" } });
    fireEvent.click(screen.getByText("Send Request"));

    expect(createMutate).toHaveBeenCalledWith({
      candidate_id: "UROS-2026-000001",
      referee_email: "newref@example.com",
      referee_phone: undefined,
    });
  });

  it("requires a mandatory reason before submitting a review decision", () => {
    render(<ReferenceCheckPanel />);
    fireEvent.change(screen.getByPlaceholderText("Candidate ID"), { target: { value: "UROS-2026-000001" } });
    fireEvent.click(screen.getByText("View Requests"));

    fireEvent.click(screen.getByText("Approve"));
    expect(reviewMutate).not.toHaveBeenCalled();
    expect(screen.getByText(/A reason is required/i)).toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText(/Mandatory reason/i), {
      target: { value: "Strong reference, approving." },
    });
    fireEvent.click(screen.getByText("Approve"));

    expect(reviewMutate).toHaveBeenCalledWith({
      resultId: "result-1",
      review_decision: "APPROVED",
      review_reason: "Strong reference, approving.",
    });
  });
});
