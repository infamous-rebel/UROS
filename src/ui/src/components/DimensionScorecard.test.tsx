import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

vi.mock("../api/client", () => ({
  getToken: () => "dev-token",
  API_V1: "http://localhost:3000/api/v1",
  authedRequest: vi.fn(),
}));

const mockDimensionScores = {
  data: {
    count: 1,
    dimension_scores: [
      {
        evaluation_id: "eval-1",
        candidate_id: "UROS-2026-0001",
        org_id: "org-1",
        persona_id: null,
        template_id: "tmpl-1",
        overall_fit_score: 82,
        recommended_decision: "AUTO_PASS",
        knockout_triggered: false,
        knockout_reason: null,
        status: "CALCULATED",
        human_reviewer: null,
        human_decision: null,
        override_reason: null,
        computed_by: "SYSTEM",
        computed_at: new Date().toISOString(),
        reviewed_at: null,
        dimension_breakdown: [
          {
            dimension_config_id: "cfg-1",
            dimension_key: "EDUCATION",
            dimension_name: "Education",
            sequence: 1,
            weight: 100,
            raw_score: 82,
            weighted_score: 82,
            is_knockout: false,
            knockout_threshold: null,
            knockout_failed: false,
            subcriteria: [
              {
                subcriterion_id: "sub-1",
                field_path: "academic.bachelor.cgpa",
                label: "Bachelor CGPA",
                operator: "GTE",
                threshold_value: 3,
                extracted_value: 3.6,
                matched: true,
                flagged: false,
                flag_reason: null,
                confidence: 0.95,
                weight: 100,
                points_earned: 82,
                reason_code: null,
                evidence_doc_type: "Bachelor Certificate",
              },
            ],
          },
        ],
      },
    ],
  },
  isLoading: false,
  isError: false,
};

const resolveMutate = vi.fn();
const runMutate = vi.fn();

vi.mock("../hooks/hooks_dimensions", () => ({
  useDimensionScores: () => mockDimensionScores,
  useResolveDimensionScore: () => ({ mutate: resolveMutate, isPending: false }),
  useRunDimensionScoring: () => ({ mutate: runMutate, isPending: false }),
  useDimensionTemplates: () => ({ data: { templates: [], count: 0 }, isLoading: false, isError: false }),
}));

import { DimensionScorecard } from "./DimensionScorecard";

describe("DimensionScorecard", () => {
  beforeEach(() => {
    resolveMutate.mockClear();
    runMutate.mockClear();
  });

  it("prompts for a candidate ID before any score is loaded", () => {
    render(<DimensionScorecard />);
    expect(screen.getByPlaceholderText(/Candidate ID/i)).toBeInTheDocument();
    expect(screen.getByText(/Enter a candidate ID and Load/i)).toBeInTheDocument();
  });

  it("renders the overall fit score, recommendation, and dimension breakdown after loading a candidate", () => {
    render(<DimensionScorecard />);

    fireEvent.change(screen.getByPlaceholderText(/Candidate ID/i), { target: { value: "UROS-2026-0001" } });
    fireEvent.click(screen.getByText("Load"));

    expect(screen.getAllByText("82").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("AUTO PASS")).toBeInTheDocument();
    expect(screen.getByText("Education")).toBeInTheDocument();
  });

  it("expands a dimension row to reveal sub-criterion evidence", () => {
    render(<DimensionScorecard />);
    fireEvent.change(screen.getByPlaceholderText(/Candidate ID/i), { target: { value: "UROS-2026-0001" } });
    fireEvent.click(screen.getByText("Load"));

    fireEvent.click(screen.getByText("Education"));

    expect(screen.getByText("Bachelor CGPA")).toBeInTheDocument();
    expect(screen.getByText("MATCH")).toBeInTheDocument();
  });

  it("calls the resolve mutation with APPROVE when Approve is clicked", () => {
    render(<DimensionScorecard />);
    fireEvent.change(screen.getByPlaceholderText(/Candidate ID/i), { target: { value: "UROS-2026-0001" } });
    fireEvent.click(screen.getByText("Load"));

    fireEvent.click(screen.getByText("Approve"));

    expect(resolveMutate).toHaveBeenCalledWith({ evaluationId: "eval-1", decision: "APPROVE" });
  });

  it("requires a reason before allowing an override to be confirmed", () => {
    render(<DimensionScorecard />);
    fireEvent.change(screen.getByPlaceholderText(/Candidate ID/i), { target: { value: "UROS-2026-0001" } });
    fireEvent.click(screen.getByText("Load"));

    fireEvent.click(screen.getByText("Override"));
    const confirmButton = screen.getByText("Confirm Override");
    expect(confirmButton).toBeDisabled();

    fireEvent.change(screen.getByPlaceholderText(/Mandatory reason/i), {
      target: { value: "Verified certificate manually" },
    });
    expect(confirmButton).not.toBeDisabled();

    fireEvent.click(confirmButton);
    expect(resolveMutate).toHaveBeenCalledWith({
      evaluationId: "eval-1",
      decision: "OVERRIDE",
      override_reason: "Verified certificate manually",
    });
  });
});
