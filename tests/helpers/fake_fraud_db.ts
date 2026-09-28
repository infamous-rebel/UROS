/**
 * Minimal stateful in-memory fake for src/database/client.ts, scoped to
 * exactly the queries fraud_detection_agent/index.ts, fraud.routes.ts,
 * and utils/audit_helper.ts issue. Dispatches on a normalized prefix of
 * the SQL text rather than parsing SQL — sufficient and honest for a
 * fixed, known query set; not a general-purpose query engine.
 */
export interface FakeFraudDbState {
  candidates: any[];
  candidate_academic_records: any[];
  candidate_experience: any[];
  fraud_checks: any[];
  fraud_flags: any[];
  audit_log: any[];
}

export function createFakeFraudDb() {
  const state: FakeFraudDbState = {
    candidates: [],
    candidate_academic_records: [],
    candidate_experience: [],
    fraud_checks: [],
    fraud_flags: [],
    audit_log: [],
  };

  let flagSeq = 1;
  let checkSeq = 1;
  let auditSeq = 1;

  async function query(text: string, params: any[] = []): Promise<{ rows: any[]; rowCount: number }> {
    const sql = text.replace(/\s+/g, " ").trim();

    if (sql.startsWith("SELECT * FROM candidates WHERE candidate_id=$1 AND org_id=$2")) {
      const [candidateId, orgId] = params;
      const rows = state.candidates.filter((c) => c.candidate_id === candidateId && c.org_id === orgId);
      return { rows, rowCount: rows.length };
    }

    if (sql.startsWith("SELECT candidate_id FROM candidates WHERE candidate_id=$1 AND org_id=$2")) {
      const [candidateId, orgId] = params;
      const rows = state.candidates
        .filter((c) => c.candidate_id === candidateId && c.org_id === orgId)
        .map((c) => ({ candidate_id: c.candidate_id }));
      return { rows, rowCount: rows.length };
    }

    if (sql.startsWith("SELECT * FROM candidate_academic_records WHERE candidate_id=$1")) {
      const [candidateId] = params;
      const rows = state.candidate_academic_records.filter((r) => r.candidate_id === candidateId);
      return { rows, rowCount: rows.length };
    }

    if (sql.startsWith("SELECT * FROM candidate_experience WHERE candidate_id=$1")) {
      const [candidateId] = params;
      const rows = state.candidate_experience.filter((r) => r.candidate_id === candidateId);
      return { rows, rowCount: rows.length };
    }

    if (sql.startsWith("SELECT * FROM fraud_checks WHERE org_id=$1 ORDER BY created_at DESC")) {
      const [orgId] = params;
      const rows = state.fraud_checks.filter((c) => c.org_id === orgId).sort((a, b) => b.created_at.localeCompare(a.created_at));
      return { rows, rowCount: rows.length };
    }

    if (sql.startsWith("SELECT * FROM fraud_checks WHERE org_id=$1")) {
      const [orgId] = params;
      const rows = state.fraud_checks.filter((c) => c.org_id === orgId);
      return { rows, rowCount: rows.length };
    }

    if (sql.startsWith("SELECT candidate_id, national_id, phone_primary, email FROM candidates WHERE org_id=$1 AND candidate_id <> $2")) {
      const orgId = params[0];
      const selfId = params[1];
      const identityValues = params.slice(2).map((v) => String(v).toLowerCase());
      const rows = state.candidates.filter(
        (c) =>
          c.org_id === orgId &&
          c.candidate_id !== selfId &&
          identityValues.some(
            (v) =>
              (c.national_id && String(c.national_id).toLowerCase() === v) ||
              (c.phone_primary && String(c.phone_primary).toLowerCase() === v) ||
              (c.email && String(c.email).toLowerCase() === v)
          )
      );
      return {
        rows: rows.map((r) => ({ candidate_id: r.candidate_id, national_id: r.national_id ?? null, phone_primary: r.phone_primary ?? null, email: r.email ?? null })),
        rowCount: rows.length,
      };
    }

    if (sql.startsWith("SELECT candidate_id FROM candidates WHERE org_id=$1 AND job_circular_id=$2")) {
      const [orgId, circularId] = params;
      const rows = state.candidates
        .filter((c) => c.org_id === orgId && c.job_circular_id === circularId)
        .sort((a, b) => a.created_at.localeCompare(b.created_at))
        .slice(0, 500)
        .map((c) => ({ candidate_id: c.candidate_id }));
      return { rows, rowCount: rows.length };
    }

    if (sql.startsWith("INSERT INTO fraud_flags")) {
      const [org_id, candidate_id, check_id, check_type, severity, reason_code, reason_description, evidence] = params;
      const flag_id = `00000000-0000-0000-0000-${String(flagSeq++).padStart(12, "0")}`;
      state.fraud_flags.push({
        flag_id,
        org_id,
        candidate_id,
        check_id,
        check_type,
        severity,
        reason_code,
        reason_description,
        evidence: JSON.parse(evidence),
        status: "OPEN",
        detected_at: new Date().toISOString(),
        reviewed_by: null,
        reviewed_at: null,
        resolution: null,
        resolution_reason: null,
      });
      return { rows: [{ flag_id }], rowCount: 1 };
    }

    if (sql.startsWith("UPDATE fraud_checks SET active=false WHERE org_id=$1 AND check_type=$2 AND active=true")) {
      const [orgId, checkType] = params;
      for (const c of state.fraud_checks) {
        if (c.org_id === orgId && c.check_type === checkType && c.active) c.active = false;
      }
      return { rows: [], rowCount: 0 };
    }

    if (sql.startsWith("INSERT INTO fraud_checks")) {
      const [org_id, name, check_type, config, is_knockout, active, created_by] = params;
      const check_id = `check-${checkSeq++}`;
      const row = {
        check_id,
        org_id,
        name,
        check_type,
        config: JSON.parse(config),
        is_knockout,
        active,
        created_by,
        created_at: new Date().toISOString(),
      };
      state.fraud_checks.push(row);
      return { rows: [row], rowCount: 1 };
    }

    if (sql.startsWith("SELECT * FROM fraud_flags WHERE candidate_id=$1 AND org_id=$2 ORDER BY detected_at DESC")) {
      const [candidateId, orgId] = params;
      const rows = state.fraud_flags
        .filter((f) => f.candidate_id === candidateId && f.org_id === orgId)
        .sort((a, b) => b.detected_at.localeCompare(a.detected_at));
      return { rows, rowCount: rows.length };
    }

    if (sql.startsWith("SELECT * FROM fraud_flags WHERE flag_id=$1 AND org_id=$2")) {
      const [flagId, orgId] = params;
      const rows = state.fraud_flags.filter((f) => f.flag_id === flagId && f.org_id === orgId);
      return { rows, rowCount: rows.length };
    }

    if (sql.startsWith("UPDATE fraud_flags SET status=$1, resolution=$2, resolution_reason=$3, reviewed_by=$4, reviewed_at=now() WHERE flag_id=$5")) {
      const [status, resolution, resolution_reason, reviewed_by, flagId] = params;
      const row = state.fraud_flags.find((f) => f.flag_id === flagId);
      if (row) {
        row.status = status;
        row.resolution = resolution;
        row.resolution_reason = resolution_reason;
        row.reviewed_by = reviewed_by;
        row.reviewed_at = new Date().toISOString();
      }
      return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
    }

    if (sql.startsWith("INSERT INTO audit_log")) {
      state.audit_log.push({ id: auditSeq++, params });
      return { rows: [], rowCount: 1 };
    }

    throw new Error(`Fake fraud DB: unhandled query: ${sql}`);
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
