import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

vi.mock("../api/client", () => ({
  getToken: () => "dev-token",
  API_V1: "http://localhost:3000/api/v1",
  authedRequest: vi.fn(),
}));

const mockChecksData = {
  data: {
    checks: [
      {
        check_type: "AGE_EDUCATION_TIMELINE",
        check_id: null,
        name: "AGE_EDUCATION_TIMELINE (system default)",
        config: {},
        is_knockout: false,
        active: true,
        is_system_default: true,
      },
      {
        check_type: "DUPLICATE_IDENTITY",
        check_id: "check-1",
        name: "Org Duplicate Identity Check",
        config: {},
        is_knockout: true,
        active: true,
        is_system_default: false,
      },
    ],
    count: 2,
    all_check_types: ["AGE_EDUCATION_TIMELINE", "DUPLICATE_IDENTITY"],
  },
  isLoading: false,
  isError: false,
};

const mockFlagsData = {
  data: {
    flags: [
      {
        flag_id: "flag-1",
        org_id: "org-1",
        candidate_id: "UROS-2026-000001",
        check_id: null,
        check_type: "DUPLICATE_IDENTITY",
        severity: "HIGH",
        reason_code: "DUPLICATE_NATIONAL_ID",
        reason_description: "This candidate shares national_id with 1 other candidate(s) in the same organization.",
        evidence: { matches: [{ field: "national_id", matched_candidate_id: "UROS-2026-000002" }] },
        status: "OPEN",
        detected_at: "2026-08-20T10:00:00Z",
        reviewed_by: null,
        reviewed_at: null,
        resolution: null,
        resolution_reason: null,
      },
    ],
    count: 1,
  },
  isLoading: false,
  isError: false,
};

const runMutate = vi.fn();
const resolveMutate = vi.fn();

vi.mock("../hooks/hooks_fraud", () => ({
  useFraudChecks: () => mockChecksData,
  useRunFraudDetection: () => ({ mutate: runMutate, isPending: false, isError: false, error: null, data: undefined }),
  useFraudFlags: () => mockFlagsData,
  useResolveFraudFlag: () => ({ mutate: resolveMutate, isPending: false }),
}));

import { FraudDetectionPanel } from "./FraudDetectionPanel";

describe("FraudDetectionPanel", () => {
  beforeEach(() => {
    runMutate.mockClear();
    resolveMutate.mockClear();
  });

  it("renders the active checks list, including system defaults and org-configured knockout checks", () => {
    render(<FraudDetectionPanel />);
    expect(screen.getByText(/Active Fraud Checks/i)).toBeInTheDocument();
    expect(screen.getByText("AGE EDUCATION TIMELINE")).toBeInTheDocument();
    expect(screen.getByText("DUPLICATE IDENTITY")).toBeInTheDocument();
    expect(screen.getByText("Knockout")).toBeInTheDocument();
    expect(screen.getByText(/System default configuration/i)).toBeInTheDocument();
  });

  it("triggers a run with comma-separated candidate IDs", () => {
    render(<FraudDetectionPanel />);
    fireEvent.change(screen.getByPlaceholderText(/Candidate IDs/i), {
      target: { value: "UROS-2026-000001, UROS-2026-000002" },
    });
    fireEvent.click(screen.getByText("Run Detection"));

    expect(runMutate).toHaveBeenCalledWith({
      candidate_ids: ["UROS-2026-000001", "UROS-2026-000002"],
      circular_id: undefined,
    });
  });

  it("looks up flags for a candidate and shows evidence + severity/status badges", () => {
    render(<FraudDetectionPanel />);
    fireEvent.change(screen.getByPlaceholderText("Candidate ID"), { target: { value: "UROS-2026-000001" } });
    fireEvent.click(screen.getByText("View Flags"));

    expect(screen.getAllByText("DUPLICATE IDENTITY").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("HIGH")).toBeInTheDocument();
    expect(screen.getByText("OPEN")).toBeInTheDocument();
    expect(screen.getByText(/DUPLICATE_NATIONAL_ID/)).toBeInTheDocument();

    fireEvent.click(screen.getByText(/Why\? \(evidence\)/i));
    expect(screen.getByText(/UROS-2026-000002/)).toBeInTheDocument();
  });

  it("requires a mandatory reason before resolving a flag", () => {
    render(<FraudDetectionPanel />);
    fireEvent.change(screen.getByPlaceholderText("Candidate ID"), { target: { value: "UROS-2026-000001" } });
    fireEvent.click(screen.getByText("View Flags"));

    fireEvent.click(screen.getByText("Confirm Fraud"));
    expect(resolveMutate).not.toHaveBeenCalled();
    expect(screen.getByText(/A reason is required/i)).toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText(/Mandatory reason/i), {
      target: { value: "Verified national ID match against NID database." },
    });
    fireEvent.click(screen.getByText("Confirm Fraud"));

    expect(resolveMutate).toHaveBeenCalledWith({
      flagId: "flag-1",
      resolution: "CONFIRMED",
      resolution_reason: "Verified national ID match against NID database.",
    });
  });
});
