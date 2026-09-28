import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

vi.mock("../api/client", () => ({
  getToken: () => "dev-token",
  API_V1: "http://localhost:3000/api/v1",
  authedRequest: vi.fn(),
}));

const mockConfigData = {
  data: {
    config: null,
    effective_quality_hire_definition: { hire_statuses: ["SELECTED"], min_score: null, thresholds: { min_pass_rate: 0.05 } },
    effective_default_time_window_days: 90,
    is_system_default: true,
  },
  isLoading: false,
  isError: false,
};

const mockSourcesData = {
  data: {
    org_id: "org-1",
    window_start: "2026-06-01T00:00:00Z",
    window_end: "2026-09-01T00:00:00Z",
    circular_id: null,
    sources: [
      {
        source_platform: "bdjobs",
        total_candidates: 300,
        eligible_pass_count: 120,
        interview_count: 40,
        selection_count: 5,
        pass_rate: 0.4,
        interview_rate: 0.133,
        selection_rate: 0.0167,
      },
    ],
    flags: [
      {
        source_platform: "LinkedIn",
        reason_code: "SOURCE_PASS_RATE_BELOW_THRESHOLD",
        reason_description: "LinkedIn has an eligibility pass rate of 1.0%, below the configured minimum of 5.0%.",
        evidence: { pass_rate: 0.01, min_pass_rate: 0.05 },
      },
    ],
    reason_code: "SOURCE_EFFECTIVENESS_COMPUTED",
    reason_description: "Computed pass/interview/selection rates for 1 source(s) from 300 candidate(s) over the last 90 day(s).",
    evidence: {},
  },
  isLoading: false,
  isError: false,
};

const mockFunnelData = {
  data: {
    org_id: "org-1",
    circular_id: "CIRC-1",
    stages: [
      { stage: "APPLIED", count: 300 },
      { stage: "ELIGIBLE", count: 120 },
      { stage: "SCORED", count: 100 },
      { stage: "SHORTLISTED", count: 40 },
      { stage: "COMMUNICATED", count: 90 },
      { stage: "SELECTED", count: 5 },
    ],
    reason_code: "FUNNEL_COMPUTED",
    reason_description: "Computed funnel stage counts for circular CIRC-1 from 300 candidate(s).",
    evidence: {},
  },
  isLoading: false,
  isError: false,
};

const mockQualityHireData = {
  data: {
    org_id: "org-1",
    window_start: "2026-06-01T00:00:00Z",
    window_end: "2026-09-01T00:00:00Z",
    quality_hire_definition: { hire_statuses: ["SELECTED"], min_score: null, thresholds: {} },
    sources: [{ source_platform: "bdjobs", total_cost: 50000, quality_hire_count: 5, cost_per_quality_hire: 10000 }],
    flags: [],
    reason_code: "QUALITY_HIRE_COST_COMPUTED",
    reason_description: "Computed cost per quality hire for 1 source(s) over the last 90 day(s).",
    evidence: {},
  },
  isLoading: false,
  isError: false,
};

const configureMutate = vi.fn();
const addCostMutate = vi.fn();

vi.mock("../hooks/hooks_analytics", async () => {
  const actual = await vi.importActual<typeof import("../hooks/hooks_analytics")>("../hooks/hooks_analytics");
  return {
    ...actual,
    useAnalyticsConfig: () => mockConfigData,
    useConfigureAnalytics: () => ({ mutate: configureMutate, isPending: false, isError: false, error: null }),
    useAddSourceCost: () => ({ mutate: addCostMutate, isPending: false, isError: false, error: null, isSuccess: false }),
    useSourceEffectiveness: () => mockSourcesData,
    useFunnelAnalysis: (circularId: string | null) => (circularId ? mockFunnelData : { data: undefined, isLoading: false, isError: false }),
    useQualityHireCost: () => mockQualityHireData,
    downloadAnalyticsExport: vi.fn(),
  };
});

import { RecruitmentAnalyticsPanel } from "./RecruitmentAnalyticsPanel";

describe("RecruitmentAnalyticsPanel", () => {
  beforeEach(() => {
    configureMutate.mockClear();
    addCostMutate.mockClear();
  });

  it("renders without crashing and shows the source comparison table", () => {
    render(<RecruitmentAnalyticsPanel />);
    expect(screen.getByText(/Source Comparison/i)).toBeInTheDocument();
    expect(screen.getAllByText("bdjobs").length).toBeGreaterThan(0);
    expect(screen.getByText("40.0%")).toBeInTheDocument(); // pass_rate
  });

  it("shows underperformance flags with reasoning and evidence", () => {
    render(<RecruitmentAnalyticsPanel />);
    expect(screen.getByText(/Underperformance Alerts/i)).toBeInTheDocument();
    expect(screen.getByText("SOURCE_PASS_RATE_BELOW_THRESHOLD")).toBeInTheDocument();
    expect(screen.getByText(/LinkedIn has an eligibility pass rate/i)).toBeInTheDocument();
  });

  it("shows the quality-hire cost table", () => {
    render(<RecruitmentAnalyticsPanel />);
    expect(screen.getAllByText(/Cost Per Quality Hire/i).length).toBeGreaterThan(0);
    expect(screen.getByText("10000.00")).toBeInTheDocument();
  });

  it("loads the funnel once a circular ID is entered", () => {
    render(<RecruitmentAnalyticsPanel />);
    expect(screen.getByText(/Enter a Circular ID above/i)).toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText(/Circular ID/i), { target: { value: "CIRC-1" } });

    expect(screen.getByText(/Funnel Analysis/i)).toBeInTheDocument();
    expect(screen.getByText("Applied")).toBeInTheDocument();
    expect(screen.getByText("Selected")).toBeInTheDocument();
  });

  it("submits a new analytics configuration", () => {
    render(<RecruitmentAnalyticsPanel />);
    fireEvent.change(screen.getByPlaceholderText(/Min pass rate/i), { target: { value: "0.1" } });
    fireEvent.click(screen.getByText("Save Configuration"));
    expect(configureMutate).toHaveBeenCalled();
  });

  it("submits a new source cost entry", () => {
    render(<RecruitmentAnalyticsPanel />);
    fireEvent.change(screen.getByPlaceholderText("Cost"), { target: { value: "5000" } });
    fireEvent.click(screen.getByText("Add Cost Entry"));
    expect(addCostMutate).toHaveBeenCalledWith(
      expect.objectContaining({ source_platform: "bdjobs", cost: 5000 })
    );
  });
});
