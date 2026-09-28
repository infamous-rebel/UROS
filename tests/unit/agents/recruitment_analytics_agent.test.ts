import {
  reduceEligibilityOutcome,
  computeSourceEffectiveness,
  computeFunnel,
  isQualityHire,
  computeCostPerQualityHire,
  flagUnderperformance,
  DEFAULT_QUALITY_HIRE_DEFINITION,
} from "../../../src/agents/recruitment_analytics_agent";
import { AnalyticsCandidateRow, EligibilityOutcome, RecruitmentSourceCost } from "../../../src/models/recruitment_analytics.model";

function candidate(overrides: Partial<AnalyticsCandidateRow>): AnalyticsCandidateRow {
  return {
    candidate_id: "C-1",
    source_platform: "bdjobs",
    job_circular_id: "CIRC-1",
    status: "INTAKE",
    window_date: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

describe("reduceEligibilityOutcome", () => {
  it("returns NOT_EVALUATED for no rows", () => {
    expect(reduceEligibilityOutcome([])).toBe("NOT_EVALUATED");
  });
  it("FAIL wins over NEEDS_REVIEW and PASS", () => {
    expect(reduceEligibilityOutcome(["PASS", "NEEDS_REVIEW", "FAIL"])).toBe("FAIL");
  });
  it("NEEDS_REVIEW wins over PASS when no FAIL present", () => {
    expect(reduceEligibilityOutcome(["PASS", "NEEDS_REVIEW"])).toBe("NEEDS_REVIEW");
  });
  it("PASS when every row passes", () => {
    expect(reduceEligibilityOutcome(["PASS", "PASS"])).toBe("PASS");
  });
});

describe("computeSourceEffectiveness", () => {
  it("computes pass/interview/selection rates per source, skipping candidates with no source", () => {
    const candidates: AnalyticsCandidateRow[] = [
      candidate({ candidate_id: "C-1", source_platform: "bdjobs", status: "SELECTED" }),
      candidate({ candidate_id: "C-2", source_platform: "bdjobs", status: "SHORTLISTED" }),
      candidate({ candidate_id: "C-3", source_platform: "bdjobs", status: "REJECTED" }),
      candidate({ candidate_id: "C-4", source_platform: "LinkedIn", status: "SELECTED" }),
      candidate({ candidate_id: "C-5", source_platform: null, status: "SELECTED" }),
    ];
    const outcomes = new Map<string, EligibilityOutcome>([
      ["C-1", "PASS"],
      ["C-2", "PASS"],
      ["C-3", "FAIL"],
      ["C-4", "PASS"],
    ]);

    const result = computeSourceEffectiveness(candidates, outcomes);
    const bdjobs = result.find((r) => r.source_platform === "bdjobs")!;
    expect(bdjobs.total_candidates).toBe(3);
    expect(bdjobs.eligible_pass_count).toBe(2);
    expect(bdjobs.interview_count).toBe(2); // SELECTED + SHORTLISTED
    expect(bdjobs.selection_count).toBe(1);
    expect(bdjobs.pass_rate).toBeCloseTo(2 / 3);
    expect(bdjobs.selection_rate).toBeCloseTo(1 / 3);

    const linkedin = result.find((r) => r.source_platform === "LinkedIn")!;
    expect(linkedin.total_candidates).toBe(1);
    expect(linkedin.selection_rate).toBe(1);

    // C-5 has no source_platform and must not appear anywhere, and must not be silently attributed to any source
    expect(result.reduce((sum, r) => sum + r.total_candidates, 0)).toBe(4);
  });

  it("omits sources with zero candidates entirely (no dead rows)", () => {
    const candidates: AnalyticsCandidateRow[] = [candidate({ source_platform: "bdjobs" })];
    const result = computeSourceEffectiveness(candidates, new Map());
    expect(result).toHaveLength(1);
    expect(result[0].source_platform).toBe("bdjobs");
  });

  it("returns zero rates (not NaN) for a source whose candidates are all still unevaluated", () => {
    const candidates: AnalyticsCandidateRow[] = [candidate({ source_platform: "Email", status: "INTAKE" })];
    const result = computeSourceEffectiveness(candidates, new Map());
    expect(result[0].pass_rate).toBe(0);
    expect(result[0].interview_rate).toBe(0);
    expect(result[0].selection_rate).toBe(0);
  });
});

describe("computeFunnel", () => {
  it("computes every stage deterministically from independent inputs", () => {
    const candidates: AnalyticsCandidateRow[] = [
      candidate({ candidate_id: "C-1", status: "SELECTED" }),
      candidate({ candidate_id: "C-2", status: "SHORTLISTED" }),
      candidate({ candidate_id: "C-3", status: "INTAKE" }),
    ];
    const outcomes = new Map<string, EligibilityOutcome>([
      ["C-1", "PASS"],
      ["C-2", "PASS"],
      ["C-3", "NOT_EVALUATED"],
    ]);
    const scored = new Set(["C-1", "C-2"]);
    const communicated = new Set(["C-1"]);

    const stages = computeFunnel(candidates, outcomes, scored, communicated);
    const byStage = Object.fromEntries(stages.map((s) => [s.stage, s.count]));
    expect(byStage.APPLIED).toBe(3);
    expect(byStage.ELIGIBLE).toBe(2);
    expect(byStage.SCORED).toBe(2);
    expect(byStage.SHORTLISTED).toBe(2); // SELECTED + SHORTLISTED both count as reaching interview stage
    expect(byStage.COMMUNICATED).toBe(1);
    expect(byStage.SELECTED).toBe(1);
  });

  it("returns all-zero stages for an empty candidate set, never throwing", () => {
    const stages = computeFunnel([], new Map(), new Set(), new Set());
    expect(stages.every((s) => s.count === 0)).toBe(true);
    expect(stages).toHaveLength(6);
  });
});

describe("isQualityHire", () => {
  it("requires status to be in hire_statuses", () => {
    const def = { hire_statuses: ["SELECTED" as const], min_score: null, thresholds: {} };
    expect(isQualityHire(candidate({ status: "SELECTED" }), null, def)).toBe(true);
    expect(isQualityHire(candidate({ status: "SHORTLISTED" }), null, def)).toBe(false);
  });

  it("additionally requires min_score when configured", () => {
    const def = { hire_statuses: ["SELECTED" as const], min_score: 70, thresholds: {} };
    expect(isQualityHire(candidate({ status: "SELECTED" }), 85, def)).toBe(true);
    expect(isQualityHire(candidate({ status: "SELECTED" }), 50, def)).toBe(false);
    expect(isQualityHire(candidate({ status: "SELECTED" }), null, def)).toBe(false); // no score on file cannot satisfy a min_score bar
  });
});

describe("computeCostPerQualityHire", () => {
  it("computes total cost, quality hire count, and cost per hire per source", () => {
    const candidates: AnalyticsCandidateRow[] = [
      candidate({ candidate_id: "C-1", source_platform: "bdjobs", status: "SELECTED" }),
      candidate({ candidate_id: "C-2", source_platform: "bdjobs", status: "REJECTED" }),
    ];
    const costs: RecruitmentSourceCost[] = [
      { cost_id: "1", org_id: "org-1", source_platform: "bdjobs", campaign_id: null, cost: 10000, effective_date: "2026-01-01", created_by: null, created_at: "2026-01-01T00:00:00Z" },
      { cost_id: "2", org_id: "org-1", source_platform: "bdjobs", campaign_id: "camp-2", cost: 5000, effective_date: "2026-01-05", created_by: null, created_at: "2026-01-05T00:00:00Z" },
    ];
    const result = computeCostPerQualityHire(candidates, new Map(), costs, DEFAULT_QUALITY_HIRE_DEFINITION);
    const bdjobs = result.find((r) => r.source_platform === "bdjobs")!;
    expect(bdjobs.total_cost).toBe(15000);
    expect(bdjobs.quality_hire_count).toBe(1);
    expect(bdjobs.cost_per_quality_hire).toBe(15000);
  });

  it("returns null (not Infinity) cost_per_quality_hire when there are zero quality hires", () => {
    const candidates: AnalyticsCandidateRow[] = [candidate({ source_platform: "LinkedIn", status: "REJECTED" })];
    const costs: RecruitmentSourceCost[] = [
      { cost_id: "1", org_id: "org-1", source_platform: "LinkedIn", campaign_id: null, cost: 2000, effective_date: "2026-01-01", created_by: null, created_at: "2026-01-01T00:00:00Z" },
    ];
    const result = computeCostPerQualityHire(candidates, new Map(), costs, DEFAULT_QUALITY_HIRE_DEFINITION);
    const linkedin = result.find((r) => r.source_platform === "LinkedIn")!;
    expect(linkedin.cost_per_quality_hire).toBeNull();
    expect(linkedin.total_cost).toBe(2000);
  });

  it("includes a source that has cost but zero candidates in the window", () => {
    const costs: RecruitmentSourceCost[] = [
      { cost_id: "1", org_id: "org-1", source_platform: "WhatsApp", campaign_id: null, cost: 500, effective_date: "2026-01-01", created_by: null, created_at: "2026-01-01T00:00:00Z" },
    ];
    const result = computeCostPerQualityHire([], new Map(), costs, DEFAULT_QUALITY_HIRE_DEFINITION);
    expect(result).toHaveLength(1);
    expect(result[0].source_platform).toBe("WhatsApp");
    expect(result[0].quality_hire_count).toBe(0);
  });
});

describe("flagUnderperformance", () => {
  it("flags a source below the configured min_pass_rate with full reasoning", () => {
    const effectiveness = [
      { source_platform: "bdjobs" as const, total_candidates: 100, eligible_pass_count: 2, interview_count: 1, selection_count: 0, pass_rate: 0.02, interview_rate: 0.01, selection_rate: 0 },
    ];
    const flags = flagUnderperformance(effectiveness, [], { min_pass_rate: 0.05 });
    expect(flags).toHaveLength(1);
    expect(flags[0].reason_code).toBe("SOURCE_PASS_RATE_BELOW_THRESHOLD");
    expect(flags[0].reason_description).toContain("bdjobs");
    expect(flags[0].evidence.pass_rate).toBe(0.02);
  });

  it("does not flag a source that meets the threshold exactly", () => {
    const effectiveness = [
      { source_platform: "bdjobs" as const, total_candidates: 100, eligible_pass_count: 5, interview_count: 1, selection_count: 0, pass_rate: 0.05, interview_rate: 0.01, selection_rate: 0 },
    ];
    const flags = flagUnderperformance(effectiveness, [], { min_pass_rate: 0.05 });
    expect(flags).toHaveLength(0);
  });

  it("flags cost per quality hire above the configured maximum", () => {
    const costs = [{ source_platform: "LinkedIn" as const, total_cost: 100000, quality_hire_count: 1, cost_per_quality_hire: 100000 }];
    const flags = flagUnderperformance([], costs, { max_cost_per_quality_hire: 50000 });
    expect(flags).toHaveLength(1);
    expect(flags[0].reason_code).toBe("SOURCE_COST_PER_QUALITY_HIRE_ABOVE_THRESHOLD");
  });

  it("flags spend with zero quality hires even without a cost threshold configured", () => {
    const costs = [{ source_platform: "Email" as const, total_cost: 3000, quality_hire_count: 0, cost_per_quality_hire: null }];
    const flags = flagUnderperformance([], costs, {});
    expect(flags.some((f) => f.reason_code === "SOURCE_ZERO_QUALITY_HIRES_WITH_SPEND")).toBe(true);
  });

  it("produces no flags when no thresholds are configured and there is no zero-hire spend", () => {
    const effectiveness = [
      { source_platform: "bdjobs" as const, total_candidates: 100, eligible_pass_count: 0, interview_count: 0, selection_count: 0, pass_rate: 0, interview_rate: 0, selection_rate: 0 },
    ];
    const costs = [{ source_platform: "bdjobs" as const, total_cost: 0, quality_hire_count: 0, cost_per_quality_hire: null }];
    expect(flagUnderperformance(effectiveness, costs, {})).toHaveLength(0);
  });
});
