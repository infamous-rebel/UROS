import { db } from "../../database/client";
import { applyOperator } from "../../rules/engine/operators";
import { logAudit } from "../../utils/audit_helper";
import {
  AnalyticsCandidateRow,
  EligibilityOutcome,
  FunnelAnalysisReport,
  FunnelStage,
  QualityHireDefinition,
  QualityHireReport,
  QualityHireSourceCost,
  RecruitmentAnalyticsConfig,
  RecruitmentSourceCost,
  SOURCE_PLATFORMS,
  SourceEffectivenessMetrics,
  SourceEffectivenessReport,
  SourcePlatform,
  UnderperformanceFlag,
  UnderperformanceThresholds,
} from "../../models/recruitment_analytics.model";
import { CandidateStatus } from "../../models/candidate.model";

/**
 * System default used for any org that has never called
 * POST /analytics/configure. Fully overridable; matches this project's
 * "figures are indicative, not exact" convention (see file 12, §2) and
 * the fraud_detection_agent DEFAULT_CHECK_CONFIGS precedent — analytics
 * works out of the box, configuring only overrides the defaults.
 */
export const DEFAULT_QUALITY_HIRE_DEFINITION: QualityHireDefinition = {
  hire_statuses: ["SELECTED"],
  min_score: null,
  thresholds: {
    min_pass_rate: 0.05,
    min_selection_rate: 0.001,
    max_cost_per_quality_hire: undefined,
  },
};
export const DEFAULT_TIME_WINDOW_DAYS = 90;

// -----------------------------------------------------------------------
// Pure, deterministic core — no I/O, fully unit-testable in isolation.
// -----------------------------------------------------------------------

/**
 * Candidate statuses that count as "reached interview stage". No
 * explicit INTERVIEWED status exists on candidates (see
 * 0003_candidates.sql); SHORTLISTED is the documented point at which a
 * candidate proceeds to written exam/interview (17_Agent_Interaction_
 * Sequence.md, Step 5), so SHORTLISTED/VERIFIED/SELECTED all imply the
 * candidate reached that stage. Documented assumption, not a hidden one.
 */
const INTERVIEW_STAGE_STATUSES: CandidateStatus[] = ["SHORTLISTED", "VERIFIED", "SELECTED"];

/** Reduces a candidate's evaluation_results rows to one outcome. FAIL wins over NEEDS_REVIEW; any PASS with no FAIL is a PASS. */
export function reduceEligibilityOutcome(statuses: Array<"PASS" | "FAIL" | "NEEDS_REVIEW">): EligibilityOutcome {
  if (statuses.length === 0) return "NOT_EVALUATED";
  if (statuses.includes("FAIL")) return "FAIL";
  if (statuses.includes("NEEDS_REVIEW")) return "NEEDS_REVIEW";
  return "PASS";
}

/**
 * Deterministic source-effectiveness computation. `evaluationOutcomes`
 * and `latestScores` are pre-reduced maps keyed by candidate_id so this
 * function stays pure and side-effect free.
 */
export function computeSourceEffectiveness(
  candidates: AnalyticsCandidateRow[],
  evaluationOutcomes: Map<string, EligibilityOutcome>
): SourceEffectivenessMetrics[] {
  const bySource = new Map<SourcePlatform, AnalyticsCandidateRow[]>();
  for (const c of candidates) {
    if (!c.source_platform) continue; // ungrouped candidates (no source recorded) are excluded from per-source metrics, never silently folded into one
    const list = bySource.get(c.source_platform) ?? [];
    list.push(c);
    bySource.set(c.source_platform, list);
  }

  const results: SourceEffectivenessMetrics[] = [];
  for (const source of SOURCE_PLATFORMS) {
    const rows = bySource.get(source);
    if (!rows || rows.length === 0) continue; // no dead rows for sources with zero applicants in the window
    const total = rows.length;
    const eligiblePass = rows.filter((r) => evaluationOutcomes.get(r.candidate_id) === "PASS").length;
    const interview = rows.filter((r) => INTERVIEW_STAGE_STATUSES.includes(r.status)).length;
    const selected = rows.filter((r) => r.status === "SELECTED").length;
    results.push({
      source_platform: source,
      total_candidates: total,
      eligible_pass_count: eligiblePass,
      interview_count: interview,
      selection_count: selected,
      pass_rate: total > 0 ? eligiblePass / total : 0,
      interview_rate: total > 0 ? interview / total : 0,
      selection_rate: total > 0 ? selected / total : 0,
    });
  }
  return results;
}

/**
 * Deterministic funnel computation for one circular. `communicatedCandidateIds`
 * is the set of candidates with at least one communication_log row.
 */
export function computeFunnel(
  candidates: AnalyticsCandidateRow[],
  evaluationOutcomes: Map<string, EligibilityOutcome>,
  scoredCandidateIds: Set<string>,
  communicatedCandidateIds: Set<string>
): FunnelStage[] {
  const applied = candidates.length;
  const eligible = candidates.filter((c) => evaluationOutcomes.get(c.candidate_id) === "PASS").length;
  const scored = candidates.filter((c) => scoredCandidateIds.has(c.candidate_id)).length;
  const shortlisted = candidates.filter((c) => INTERVIEW_STAGE_STATUSES.includes(c.status)).length;
  const communicated = candidates.filter((c) => communicatedCandidateIds.has(c.candidate_id)).length;
  const selected = candidates.filter((c) => c.status === "SELECTED").length;

  return [
    { stage: "APPLIED", count: applied },
    { stage: "ELIGIBLE", count: eligible },
    { stage: "SCORED", count: scored },
    { stage: "SHORTLISTED", count: shortlisted },
    { stage: "COMMUNICATED", count: communicated },
    { stage: "SELECTED", count: selected },
  ];
}

/** Whether a candidate counts as a "quality hire" per the org's configured definition. */
export function isQualityHire(
  candidate: AnalyticsCandidateRow,
  latestScore: number | null,
  definition: QualityHireDefinition
): boolean {
  if (!definition.hire_statuses.includes(candidate.status)) return false;
  if (definition.min_score !== null && definition.min_score !== undefined) {
    if (latestScore === null || latestScore < definition.min_score) return false;
  }
  return true;
}

/** Deterministic cost-per-quality-hire computation, one row per source present in either the candidate set or the cost set. */
export function computeCostPerQualityHire(
  candidates: AnalyticsCandidateRow[],
  latestScores: Map<string, number>,
  costs: RecruitmentSourceCost[],
  definition: QualityHireDefinition
): QualityHireSourceCost[] {
  const bySource = new Map<SourcePlatform, AnalyticsCandidateRow[]>();
  for (const c of candidates) {
    if (!c.source_platform) continue;
    const list = bySource.get(c.source_platform) ?? [];
    list.push(c);
    bySource.set(c.source_platform, list);
  }

  const costBySource = new Map<SourcePlatform, number>();
  for (const cost of costs) {
    costBySource.set(cost.source_platform, (costBySource.get(cost.source_platform) ?? 0) + Number(cost.cost));
  }

  const relevantSources = new Set<SourcePlatform>([...bySource.keys(), ...costBySource.keys()]);

  const results: QualityHireSourceCost[] = [];
  for (const source of SOURCE_PLATFORMS) {
    if (!relevantSources.has(source)) continue;
    const rows = bySource.get(source) ?? [];
    const qualityHireCount = rows.filter((r) => isQualityHire(r, latestScores.get(r.candidate_id) ?? null, definition)).length;
    const totalCost = costBySource.get(source) ?? 0;
    results.push({
      source_platform: source,
      total_cost: totalCost,
      quality_hire_count: qualityHireCount,
      cost_per_quality_hire: qualityHireCount > 0 ? totalCost / qualityHireCount : null,
    });
  }
  return results;
}

/**
 * Flags sources whose effectiveness metrics fall outside configured
 * thresholds. Every flag carries reason_code/reason_description/
 * evidence per UROS_Global_Reasoning_Standard.md. Read-only: this
 * function never writes anything and never recommends a final
 * decision — it only surfaces the numbers and the rule that tripped.
 */
export function flagUnderperformance(
  effectiveness: SourceEffectivenessMetrics[],
  costs: QualityHireSourceCost[],
  thresholds: UnderperformanceThresholds
): UnderperformanceFlag[] {
  const flags: UnderperformanceFlag[] = [];

  if (thresholds.min_pass_rate !== undefined && thresholds.min_pass_rate !== null) {
    for (const m of effectiveness) {
      if (!applyOperator(m.pass_rate, "GTE", thresholds.min_pass_rate)) {
        flags.push({
          source_platform: m.source_platform,
          reason_code: "SOURCE_PASS_RATE_BELOW_THRESHOLD",
          reason_description: `${m.source_platform} has an eligibility pass rate of ${(m.pass_rate * 100).toFixed(1)}%, below the configured minimum of ${(thresholds.min_pass_rate * 100).toFixed(1)}%.`,
          evidence: {
            source_platform: m.source_platform,
            pass_rate: m.pass_rate,
            min_pass_rate: thresholds.min_pass_rate,
            total_candidates: m.total_candidates,
            eligible_pass_count: m.eligible_pass_count,
          },
        });
      }
    }
  }

  if (thresholds.min_selection_rate !== undefined && thresholds.min_selection_rate !== null) {
    for (const m of effectiveness) {
      if (!applyOperator(m.selection_rate, "GTE", thresholds.min_selection_rate)) {
        flags.push({
          source_platform: m.source_platform,
          reason_code: "SOURCE_SELECTION_RATE_BELOW_THRESHOLD",
          reason_description: `${m.source_platform} has a final selection rate of ${(m.selection_rate * 100).toFixed(3)}%, below the configured minimum of ${(thresholds.min_selection_rate * 100).toFixed(3)}%.`,
          evidence: {
            source_platform: m.source_platform,
            selection_rate: m.selection_rate,
            min_selection_rate: thresholds.min_selection_rate,
            total_candidates: m.total_candidates,
            selection_count: m.selection_count,
          },
        });
      }
    }
  }

  // Cost-threshold flag: only meaningful when an org has configured a
  // max_cost_per_quality_hire, since there is no universal default for
  // "too expensive" (currency and hiring cost vary enormously by org).
  if (thresholds.max_cost_per_quality_hire !== undefined && thresholds.max_cost_per_quality_hire !== null) {
    for (const c of costs) {
      if (c.cost_per_quality_hire !== null && !applyOperator(c.cost_per_quality_hire, "LTE", thresholds.max_cost_per_quality_hire)) {
        flags.push({
          source_platform: c.source_platform,
          reason_code: "SOURCE_COST_PER_QUALITY_HIRE_ABOVE_THRESHOLD",
          reason_description: `${c.source_platform} costs ${c.cost_per_quality_hire.toFixed(2)} per quality hire, exceeding the configured maximum of ${thresholds.max_cost_per_quality_hire}.`,
          evidence: {
            source_platform: c.source_platform,
            cost_per_quality_hire: c.cost_per_quality_hire,
            max_cost_per_quality_hire: thresholds.max_cost_per_quality_hire,
            total_cost: c.total_cost,
            quality_hire_count: c.quality_hire_count,
          },
        });
      }
    }
  }

  // Zero-quality-hire-with-spend flag: unconditional (no threshold to
  // configure) — spending anything for zero quality hires is always
  // worth a human glance, regardless of whether a cost ceiling is set.
  for (const c of costs) {
    if (c.cost_per_quality_hire === null && c.total_cost > 0) {
      flags.push({
        source_platform: c.source_platform,
        reason_code: "SOURCE_ZERO_QUALITY_HIRES_WITH_SPEND",
        reason_description: `${c.source_platform} recorded ${c.total_cost} in cost but produced zero quality hires in the reporting window.`,
        evidence: { source_platform: c.source_platform, total_cost: c.total_cost, quality_hire_count: c.quality_hire_count },
      });
    }
  }

  return flags;
}

// -----------------------------------------------------------------------
// I/O — assembling data, resolving config, orchestrating a report.
// -----------------------------------------------------------------------

export async function loadAnalyticsConfig(orgId: string): Promise<RecruitmentAnalyticsConfig | null> {
  const res = await db.query<RecruitmentAnalyticsConfig>(`SELECT * FROM recruitment_analytics_configs WHERE org_id=$1`, [orgId]);
  return res.rows[0] ?? null;
}

/** Effective quality-hire definition + time window: org config where configured, system defaults otherwise. Mirrors buildEffectiveChecks in fraud_detection_agent. */
export async function resolveEffectiveConfig(
  orgId: string
): Promise<{ definition: QualityHireDefinition; default_time_window_days: number; is_system_default: boolean }> {
  const configured = await loadAnalyticsConfig(orgId);
  if (!configured) {
    return { definition: DEFAULT_QUALITY_HIRE_DEFINITION, default_time_window_days: DEFAULT_TIME_WINDOW_DAYS, is_system_default: true };
  }
  return { definition: configured.quality_hire_definition, default_time_window_days: configured.default_time_window_days, is_system_default: false };
}

function windowStart(days: number): Date {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d;
}

async function loadCandidatesInWindow(
  orgId: string,
  since: Date,
  circularId?: string,
  sourcePlatform?: SourcePlatform
): Promise<AnalyticsCandidateRow[]> {
  const conditions = [`c.org_id=$1`, `COALESCE(c.application_date, c.created_at) >= $2`];
  const params: unknown[] = [orgId, since.toISOString()];
  if (circularId) {
    params.push(circularId);
    conditions.push(`c.job_circular_id=$${params.length}`);
  }
  if (sourcePlatform) {
    params.push(sourcePlatform);
    conditions.push(`c.source_platform=$${params.length}`);
  }
  const res = await db.query(
    `SELECT c.candidate_id, c.source_platform, c.job_circular_id, c.status,
            COALESCE(c.application_date, c.created_at) AS window_date
     FROM candidates c
     WHERE ${conditions.join(" AND ")}`,
    params
  );
  return res.rows.map((r: any) => ({
    candidate_id: r.candidate_id,
    source_platform: r.source_platform ?? null,
    job_circular_id: r.job_circular_id ?? null,
    status: r.status,
    window_date: new Date(r.window_date).toISOString(),
  }));
}

async function loadEvaluationOutcomes(orgId: string, candidateIds: string[]): Promise<Map<string, EligibilityOutcome>> {
  const outcomes = new Map<string, EligibilityOutcome>();
  if (candidateIds.length === 0) return outcomes;
  const res = await db.query(
    `SELECT er.candidate_id, er.status
     FROM evaluation_results er
     JOIN candidates c ON c.candidate_id = er.candidate_id
     WHERE c.org_id=$1 AND er.candidate_id = ANY($2::text[])`,
    [orgId, candidateIds]
  );
  const byCandidate = new Map<string, Array<"PASS" | "FAIL" | "NEEDS_REVIEW">>();
  for (const row of res.rows as Array<{ candidate_id: string; status: "PASS" | "FAIL" | "NEEDS_REVIEW" }>) {
    const list = byCandidate.get(row.candidate_id) ?? [];
    list.push(row.status);
    byCandidate.set(row.candidate_id, list);
  }
  for (const id of candidateIds) {
    outcomes.set(id, reduceEligibilityOutcome(byCandidate.get(id) ?? []));
  }
  return outcomes;
}

async function loadLatestScores(orgId: string, candidateIds: string[]): Promise<Map<string, number>> {
  const scores = new Map<string, number>();
  if (candidateIds.length === 0) return scores;
  const res = await db.query(
    `SELECT sr.candidate_id, sr.total_score
     FROM scoring_results sr
     JOIN candidates c ON c.candidate_id = sr.candidate_id
     WHERE c.org_id=$1 AND sr.candidate_id = ANY($2::text[])
     ORDER BY sr.computed_at DESC`,
    [orgId, candidateIds]
  );
  for (const row of res.rows as Array<{ candidate_id: string; total_score: number }>) {
    if (!scores.has(row.candidate_id)) scores.set(row.candidate_id, Number(row.total_score)); // first row per candidate = most recent (query ordered DESC)
  }
  return scores;
}

async function loadScoredCandidateIds(orgId: string, candidateIds: string[]): Promise<Set<string>> {
  const scores = await loadLatestScores(orgId, candidateIds);
  return new Set(scores.keys());
}

async function loadCommunicatedCandidateIds(orgId: string, candidateIds: string[]): Promise<Set<string>> {
  if (candidateIds.length === 0) return new Set();
  const res = await db.query(
    `SELECT DISTINCT cl.candidate_id
     FROM communication_log cl
     JOIN candidates c ON c.candidate_id = cl.candidate_id
     WHERE c.org_id=$1 AND cl.candidate_id = ANY($2::text[])`,
    [orgId, candidateIds]
  );
  return new Set((res.rows as Array<{ candidate_id: string }>).map((r) => r.candidate_id));
}

async function loadCosts(orgId: string, since: Date, until: Date, sourcePlatform?: SourcePlatform): Promise<RecruitmentSourceCost[]> {
  const conditions = [`org_id=$1`, `effective_date >= $2`, `effective_date <= $3`];
  const params: unknown[] = [orgId, since.toISOString().slice(0, 10), until.toISOString().slice(0, 10)];
  if (sourcePlatform) {
    params.push(sourcePlatform);
    conditions.push(`source_platform=$${params.length}`);
  }
  const res = await db.query<RecruitmentSourceCost>(`SELECT * FROM recruitment_source_costs WHERE ${conditions.join(" AND ")}`, params);
  return res.rows;
}

/**
 * GET /analytics/sources orchestration: source effectiveness +
 * underperformance flags for an optional circular, over the effective
 * (configured or default) time window. Read-only — audits the query
 * itself (evidence of what was computed and when) but writes nothing
 * else, per the Master Feature Doc / Global Reasoning Standard.
 */
export async function getSourceEffectivenessReport(
  orgId: string,
  actor: string,
  options: { circular_id?: string; time_window_days?: number } = {}
): Promise<SourceEffectivenessReport> {
  const { definition, default_time_window_days } = await resolveEffectiveConfig(orgId);
  const windowDays = options.time_window_days ?? default_time_window_days;
  const since = windowStart(windowDays);
  const until = new Date();

  const candidates = await loadCandidatesInWindow(orgId, since, options.circular_id);
  const evaluationOutcomes = await loadEvaluationOutcomes(orgId, candidates.map((c) => c.candidate_id));
  const sources = computeSourceEffectiveness(candidates, evaluationOutcomes);

  const latestScores = await loadLatestScores(orgId, candidates.map((c) => c.candidate_id));
  const costs = await loadCosts(orgId, since, until);
  const costPerHire = computeCostPerQualityHire(candidates, latestScores, costs, definition);
  const flags = flagUnderperformance(sources, costPerHire, definition.thresholds);

  const report: SourceEffectivenessReport = {
    org_id: orgId,
    window_start: since.toISOString(),
    window_end: until.toISOString(),
    circular_id: options.circular_id ?? null,
    sources,
    flags,
    reason_code: "SOURCE_EFFECTIVENESS_COMPUTED",
    reason_description: `Computed pass/interview/selection rates for ${sources.length} source(s) from ${candidates.length} candidate(s) over the last ${windowDays} day(s).`,
    evidence: { window_days: windowDays, candidate_count: candidates.length, circular_id: options.circular_id ?? null },
  };

  await logAudit({
    org_id: orgId,
    entity_type: "RECRUITMENT_ANALYTICS",
    entity_id: orgId,
    agent_or_user: actor,
    action: "ANALYTICS_SOURCES_COMPUTED",
    input_value: { circular_id: options.circular_id ?? null, time_window_days: windowDays },
    output_value: { source_count: sources.length, flag_count: flags.length, candidate_count: candidates.length },
    reason_code: report.reason_code,
    reason_comment: report.reason_description,
  });

  return report;
}

/**
 * GET /analytics/funnel orchestration: funnel stage counts for one
 * circular, org-scoped, using candidates + evaluation_results +
 * scoring_results + communication_log.
 */
export async function getFunnelAnalysisReport(orgId: string, actor: string, circularId: string): Promise<FunnelAnalysisReport> {
  // Funnel is a full-history view of the circular, not time-windowed —
  // a circular can span months and every applicant belongs in it.
  const since = new Date(0);
  const candidates = await loadCandidatesInWindow(orgId, since, circularId);
  const candidateIds = candidates.map((c) => c.candidate_id);
  const evaluationOutcomes = await loadEvaluationOutcomes(orgId, candidateIds);
  const scoredIds = await loadScoredCandidateIds(orgId, candidateIds);
  const communicatedIds = await loadCommunicatedCandidateIds(orgId, candidateIds);

  const stages = computeFunnel(candidates, evaluationOutcomes, scoredIds, communicatedIds);

  const report: FunnelAnalysisReport = {
    org_id: orgId,
    circular_id: circularId,
    stages,
    reason_code: "FUNNEL_COMPUTED",
    reason_description: `Computed funnel stage counts for circular ${circularId} from ${candidates.length} candidate(s).`,
    evidence: { candidate_count: candidates.length, circular_id: circularId },
  };

  await logAudit({
    org_id: orgId,
    entity_type: "RECRUITMENT_ANALYTICS",
    entity_id: circularId,
    agent_or_user: actor,
    action: "ANALYTICS_FUNNEL_COMPUTED",
    input_value: { circular_id: circularId },
    output_value: { stages },
    reason_code: report.reason_code,
    reason_comment: report.reason_description,
  });

  return report;
}

/**
 * GET /analytics/quality-hire orchestration: cost-per-quality-hire per
 * source over the effective time window, plus underperformance flags
 * against the configured max_cost_per_quality_hire threshold.
 */
export async function getQualityHireReport(
  orgId: string,
  actor: string,
  options: { time_window_days?: number; source_platform?: SourcePlatform } = {}
): Promise<QualityHireReport> {
  const { definition, default_time_window_days } = await resolveEffectiveConfig(orgId);
  const windowDays = options.time_window_days ?? default_time_window_days;
  const since = windowStart(windowDays);
  const until = new Date();

  const candidates = await loadCandidatesInWindow(orgId, since, undefined, options.source_platform);
  const latestScores = await loadLatestScores(orgId, candidates.map((c) => c.candidate_id));
  const costs = await loadCosts(orgId, since, until, options.source_platform);
  const sources = computeCostPerQualityHire(candidates, latestScores, costs, definition);

  const effectiveness = computeSourceEffectiveness(candidates, await loadEvaluationOutcomes(orgId, candidates.map((c) => c.candidate_id)));
  const flags = flagUnderperformance(effectiveness, sources, definition.thresholds).filter(
    (f) => f.reason_code === "SOURCE_COST_PER_QUALITY_HIRE_ABOVE_THRESHOLD" || f.reason_code === "SOURCE_ZERO_QUALITY_HIRES_WITH_SPEND"
  );

  const report: QualityHireReport = {
    org_id: orgId,
    window_start: since.toISOString(),
    window_end: until.toISOString(),
    quality_hire_definition: definition,
    sources,
    flags,
    reason_code: "QUALITY_HIRE_COST_COMPUTED",
    reason_description: `Computed cost per quality hire for ${sources.length} source(s) over the last ${windowDays} day(s), using hire_statuses=[${definition.hire_statuses.join(", ")}]${definition.min_score !== null ? ` and min_score=${definition.min_score}` : ""}.`,
    evidence: { window_days: windowDays, candidate_count: candidates.length, quality_hire_definition: definition },
  };

  await logAudit({
    org_id: orgId,
    entity_type: "RECRUITMENT_ANALYTICS",
    entity_id: orgId,
    agent_or_user: actor,
    action: "ANALYTICS_QUALITY_HIRE_COMPUTED",
    input_value: { time_window_days: windowDays, source_platform: options.source_platform ?? null },
    output_value: { source_count: sources.length, flag_count: flags.length },
    reason_code: report.reason_code,
    reason_comment: report.reason_description,
  });

  return report;
}
