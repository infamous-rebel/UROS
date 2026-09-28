import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

vi.mock("../api/client", () => ({
  API_V1: "http://localhost:3000/api/v1",
}));

const requestOtpMutate = vi.fn();
const verifyOtpMutate = vi.fn();
const submitAppealMutate = vi.fn();
const getApplicantTokenMock = vi.fn();

const mockStatusData = {
  data: {
    status: {
      candidate_id: "UROS-2026-000777",
      full_name: "Fatema Akter",
      position_applied: "Senior Officer",
      job_circular_id: "BSC-2026-05",
      stage: "Needs Review",
      stage_pill: "amber",
      reasons: [
        {
          reason_code: "AGE_OVER_30",
          reason_description: 'The rule requires "age_years" to be less than or equal to 30. Your submitted value did not meet this requirement.',
          status: "FAIL",
          evidence: { rule_applied: "AGE_LIMIT", field_path: "age_years", extracted_value: 32, confidence: 1 },
          evaluated_at: new Date().toISOString(),
        },
      ],
      evidence_documents: [{ doc_type: "HSC Certificate", verification_status: "Verified" }],
      estimated_timeline_text: "Updates are typically posted within 2-3 weeks of each stage.",
      next_expected_update: "The next update will appear here once your application moves to its next stage.",
      appeal_enabled: true,
      language: "en",
      reason_code: "STAGE_NEEDS_REVIEW",
      reason_description: "One or more checks on your application need a human reviewer's attention.",
    },
  },
  isLoading: false,
  isError: false,
  error: null,
};

vi.mock("../hooks/hooks_applicant_portal", () => ({
  getApplicantToken: () => getApplicantTokenMock(),
  clearApplicantToken: vi.fn(),
  useRequestOtp: () => ({ mutate: requestOtpMutate, isPending: false }),
  useVerifyOtp: () => ({ mutate: verifyOtpMutate, isPending: false, isError: false }),
  useApplicantStatus: () => mockStatusData,
  useSubmitAppeal: () => ({ mutate: submitAppealMutate, isPending: false, isError: false, isSuccess: false }),
}));

import { ApplicantStatusPortal } from "./ApplicantStatusPortal";

describe("ApplicantStatusPortal", () => {
  beforeEach(() => {
    requestOtpMutate.mockClear();
    verifyOtpMutate.mockClear();
    submitAppealMutate.mockClear();
    getApplicantTokenMock.mockReturnValue(null);
  });

  it("renders the login screen (Candidate ID + channel) when no session token is present", () => {
    render(<ApplicantStatusPortal />);

    expect(screen.getByText(/Check Your Application Status/i)).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/Candidate ID/i)).toBeInTheDocument();
    expect(screen.getByText("Send Login Code")).toBeDisabled();
  });

  it("requests an OTP and advances to the verify step", async () => {
    requestOtpMutate.mockImplementation((_vars, { onSuccess }: any) => onSuccess());
    render(<ApplicantStatusPortal />);

    fireEvent.change(screen.getByPlaceholderText(/Candidate ID/i), { target: { value: "UROS-2026-000777" } });
    fireEvent.click(screen.getByText("Send Login Code"));

    expect(requestOtpMutate).toHaveBeenCalledWith({ candidateId: "UROS-2026-000777", channel: "EMAIL" }, expect.anything());
    await waitFor(() => expect(screen.getByPlaceholderText(/6-digit code/i)).toBeInTheDocument());
  });

  it("renders the status screen with stage pill and full name when authenticated", () => {
    getApplicantTokenMock.mockReturnValue("session-token");
    render(<ApplicantStatusPortal />);

    expect(screen.getByText("Fatema Akter")).toBeInTheDocument();
    expect(screen.getByText("Needs Review")).toBeInTheDocument();
    expect(screen.getByText(/Senior Officer/)).toBeInTheDocument();
  });

  it("expands a reason's Why? link to reveal reason_code, reason_description, and evidence", () => {
    getApplicantTokenMock.mockReturnValue("session-token");
    render(<ApplicantStatusPortal />);

    const whyLinks = screen.getAllByText(/Why\?/);
    fireEvent.click(whyLinks[whyLinks.length - 1]); // the reason card's Why?, not the top-level stage one

    expect(screen.getByText("AGE_OVER_30")).toBeInTheDocument();
    expect(screen.getByText(/did not meet this requirement/i)).toBeInTheDocument();
    expect(screen.getByText("AGE_LIMIT")).toBeInTheDocument();
  });

  it("shows the appeal form and submits with a mandatory reason", () => {
    getApplicantTokenMock.mockReturnValue("session-token");
    render(<ApplicantStatusPortal />);

    fireEvent.click(screen.getByText("Request a Review / Appeal"));
    const submitButton = screen.getByText("Submit Appeal");
    expect(submitButton).toBeDisabled();

    fireEvent.change(screen.getByPlaceholderText(/Explain why/i), { target: { value: "My HSC certificate actually shows First Division." } });
    expect(submitButton).not.toBeDisabled();

    fireEvent.click(submitButton);
    expect(submitAppealMutate).toHaveBeenCalledWith(
      expect.objectContaining({ candidateId: "UROS-2026-000777", reasonText: "My HSC certificate actually shows First Division." })
    );
  });
});
