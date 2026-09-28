/**
 * Minimal stateful in-memory fake for src/database/client.ts, scoped to
 * exactly the queries recruitment_analytics_agent/index.ts,
 * analytics.routes.ts, report_agent (unused DB-side here), and
 * utils/audit_helper.ts issue. Dispatches on a normalized prefix of the
 * SQL text rather than parsing SQL — sufficient and honest for a fixed,
 * known query set; not a general-purpose query engine. Mirrors
 * tests/helpers/fake_fraud_db.ts.
 */
export interface FakeAnalyticsDbState {
  candidates: any[];
  evaluation_results: any[];
  scoring_results: any[];
  communication_log: any[];
  recruitment_analytics_configs: any[];
  recruitment_source_costs: any[];
  audit_log: any[];
}

export function createFakeAnalyticsDb() {
  const state: FakeAnalyticsDbState = {
    candidates: [],
    evaluation_results: [],
    scoring_results: [],
    communication_log: [],
    recruitment_analytics_configs: [],
    recruitment_source_costs: [],
    audit_log: [],
  };

  let configSeq = 1;
  let costSeq = 1;
  let auditSeq = 1;

  async function query(text: string, params: any[] = []): Promise<{ rows: any[]; rowCount: number }> {
    const sql = text.replace(/\s+/g, " ").trim();

    // --- recruitment_analytics_configs -----------------------------------
    if (sql.startsWith("SELECT * FROM recruitment_analytics_configs WHERE org_id=$1")) {
      const [orgId] = params;
      const rows = state.recruitment_analytics_configs.filter((c) => c.org_id === orgId);
      return { rows, rowCount: rows.length };
    }

    if (sql.startsWith("INSERT INTO recruitment_analytics_configs")) {
      const [org_id, quality_hire_definition, default_time_window_days, created_by] = params;
      const existingIdx = state.recruitment_analytics_configs.findIndex((c) => c.org_id === org_id);
      const now = new Date().toISOString();
      if (existingIdx >= 0) {
        const existing = state.recruitment_analytics_configs[existingIdx];
        existing.quality_hire_definition = JSON.parse(quality_hire_definition);
        existing.default_time_window_days = default_time_window_days;
        existing.updated_at = now;
        return { rows: [existing], rowCount: 1 };
      }
      const row = {
        config_id: `config-${configSeq++}`,
        org_id,
        quality_hire_definition: JSON.parse(quality_hire_definition),
        default_time_window_days,
        created_by,
        created_at: now,
        updated_at: now,
      };
      state.recruitment_analytics_configs.push(row);
      return { rows: [row], rowCount: 1 };
    }

    // --- recruitment_source_costs ------------------------------------------
    if (sql.startsWith("INSERT INTO recruitment_source_costs")) {
      const [org_id, source_platform, campaign_id, cost, effective_date, created_by] = params;
      const row = {
        cost_id: `cost-${costSeq++}`,
        org_id,
        source_platform,
        campaign_id,
        cost: Number(cost),
        effective_date,
        created_by,
        created_at: new Date().toISOString(),
      };
      state.recruitment_source_costs.push(row);
      return { rows: [row], rowCount: 1 };
    }

    if (sql.startsWith("SELECT * FROM recruitment_source_costs WHERE")) {
      // org_id=$1 AND effective_date >= $2 AND effective_date <= $3 [AND source_platform=$4]
      const [orgId, since, until, sourcePlatform] = params;
      const rows = state.recruitment_source_costs.filter(
        (c) =>
          c.org_id === orgId &&
          c.effective_date >= since &&
          c.effective_date <= until &&
          (sourcePlatform === undefined || c.source_platform === sourcePlatform)
      );
      return { rows, rowCount: rows.length };
    }

    // --- candidates ----------------------------------------------------
    if (sql.startsWith("SELECT c.candidate_id, c.source_platform, c.job_circular_id, c.status")) {
      const orgId = params[0];
      const since = params[1];
      let idx = 2;
      let circularId: string | undefined;
      let sourcePlatform: string | undefined;
      if (sql.includes("c.job_circular_id=$")) {
        circularId = params[idx++];
      }
      if (sql.includes("c.source_platform=$")) {
        sourcePlatform = params[idx++];
      }
      const rows = state.candidates.filter((c) => {
        if (c.org_id !== orgId) return false;
        const windowDate = c.application_date ?? c.created_at;
        if (windowDate < since) return false;
        if (circularId !== undefined && c.job_circular_id !== circularId) return false;
        if (sourcePlatform !== undefined && c.source_platform !== sourcePlatform) return false;
        return true;
      });
      return {
        rows: rows.map((c) => ({
          candidate_id: c.candidate_id,
          source_platform: c.source_platform ?? null,
          job_circular_id: c.job_circular_id ?? null,
          status: c.status,
          window_date: c.application_date ?? c.created_at,
        })),
        rowCount: rows.length,
      };
    }

    // --- evaluation_results ---------------------------------------------
    if (sql.startsWith("SELECT er.candidate_id, er.status")) {
      const [orgId, candidateIds] = params;
      const orgCandidateIds = new Set(state.candidates.filter((c) => c.org_id === orgId).map((c) => c.candidate_id));
      const rows = state.evaluation_results.filter((e) => orgCandidateIds.has(e.candidate_id) && candidateIds.includes(e.candidate_id));
      return { rows: rows.map((r) => ({ candidate_id: r.candidate_id, status: r.status })), rowCount: rows.length };
    }

    // --- scoring_results --------------------------------------------------
    if (sql.startsWith("SELECT sr.candidate_id, sr.total_score")) {
      const [orgId, candidateIds] = params;
      const orgCandidateIds = new Set(state.candidates.filter((c) => c.org_id === orgId).map((c) => c.candidate_id));
      const rows = state.scoring_results
        .filter((s) => orgCandidateIds.has(s.candidate_id) && candidateIds.includes(s.candidate_id))
        .sort((a, b) => b.computed_at.localeCompare(a.computed_at));
      return { rows: rows.map((r) => ({ candidate_id: r.candidate_id, total_score: r.total_score })), rowCount: rows.length };
    }

    // --- communication_log ------------------------------------------------
    if (sql.startsWith("SELECT DISTINCT cl.candidate_id")) {
      const [orgId, candidateIds] = params;
      const orgCandidateIds = new Set(state.candidates.filter((c) => c.org_id === orgId).map((c) => c.candidate_id));
      const matched = new Set(
        state.communication_log.filter((m) => orgCandidateIds.has(m.candidate_id) && candidateIds.includes(m.candidate_id)).map((m) => m.candidate_id)
      );
      return { rows: Array.from(matched).map((candidate_id) => ({ candidate_id })), rowCount: matched.size };
    }

    // --- audit ------------------------------------------------------------
    if (sql.startsWith("INSERT INTO audit_log")) {
      state.audit_log.push({ id: auditSeq++, params });
      return { rows: [], rowCount: 1 };
    }

    throw new Error(`Fake analytics DB: unhandled query: ${sql}`);
  }

  const fakeClient: { query: typeof query } = { query };

  return {
    state,
    db: {
      query,
      withTransaction: async <T>(fn: (client: typeof fakeClient) => Promise<T>): Promise<T> => fn(fakeClient),
    },
  };
}
