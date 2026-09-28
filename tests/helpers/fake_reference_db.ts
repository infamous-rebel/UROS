/**
 * Minimal stateful in-memory fake for src/database/client.ts, scoped to
 * exactly the queries reference_check_agent/index.ts, reference.routes.ts,
 * and utils/audit_helper.ts issue. Dispatches on a normalized prefix of
 * the SQL text rather than parsing SQL — sufficient and honest for a
 * fixed, known query set; not a general-purpose query engine. Mirrors
 * tests/helpers/fake_fraud_db.ts.
 */
export interface FakeReferenceDbState {
  candidates: any[];
  reference_question_sets: any[];
  reference_requests: any[];
  reference_responses: any[];
  reference_results: any[];
  audit_log: any[];
}

export function createFakeReferenceDb() {
  const state: FakeReferenceDbState = {
    candidates: [],
    reference_question_sets: [],
    reference_requests: [],
    reference_responses: [],
    reference_results: [],
    audit_log: [],
  };

  let qsSeq = 1;
  let reqSeq = 1;
  let respSeq = 1;
  let resultSeq = 1;
  let auditSeq = 1;

  function coalesceKey(personaId: string | null): string {
    return personaId ?? "default";
  }

  async function query(text: string, params: any[] = []): Promise<{ rows: any[]; rowCount: number }> {
    const sql = text.replace(/\s+/g, " ").trim();

    // ---- candidates ----
    if (sql.startsWith("SELECT candidate_id, full_name FROM candidates WHERE candidate_id=$1 AND org_id=$2")) {
      const [candidateId, orgId] = params;
      const rows = state.candidates
        .filter((c) => c.candidate_id === candidateId && c.org_id === orgId)
        .map((c) => ({ candidate_id: c.candidate_id, full_name: c.full_name }));
      return { rows, rowCount: rows.length };
    }
    if (sql.startsWith("SELECT candidate_id FROM candidates WHERE candidate_id=$1 AND org_id=$2")) {
      const [candidateId, orgId] = params;
      const rows = state.candidates
        .filter((c) => c.candidate_id === candidateId && c.org_id === orgId)
        .map((c) => ({ candidate_id: c.candidate_id }));
      return { rows, rowCount: rows.length };
    }

    // ---- reference_question_sets ----
    if (sql.startsWith("SELECT * FROM reference_question_sets WHERE org_id=$1 AND persona_id=$2 AND active=true")) {
      const [orgId, personaId] = params;
      const rows = state.reference_question_sets.filter((q) => q.org_id === orgId && q.persona_id === personaId && q.active);
      return { rows, rowCount: rows.length };
    }
    if (sql.startsWith("SELECT * FROM reference_question_sets WHERE org_id=$1 AND persona_id IS NULL AND active=true")) {
      const [orgId] = params;
      const rows = state.reference_question_sets.filter((q) => q.org_id === orgId && q.persona_id === null && q.active);
      return { rows, rowCount: rows.length };
    }
    if (sql.startsWith("INSERT INTO reference_question_sets (org_id, persona_id, name, questions, version, active, created_by) VALUES ($1, NULL")) {
      const [orgId, questionsJson] = params;
      const row = {
        question_set_id: `00000000-0000-0000-1001-${String(qsSeq++).padStart(12, "0")}`,
        org_id: orgId,
        persona_id: null,
        name: "UROS Default Reference Questions",
        questions: JSON.parse(questionsJson),
        version: 1,
        active: true,
        created_by: null,
        created_at: new Date().toISOString(),
      };
      state.reference_question_sets.push(row);
      return { rows: [row], rowCount: 1 };
    }
    if (sql.startsWith("UPDATE reference_question_sets SET active=false")) {
      const [orgId, personaId] = params;
      for (const q of state.reference_question_sets) {
        if (q.org_id === orgId && coalesceKey(q.persona_id) === coalesceKey(personaId) && q.active) q.active = false;
      }
      return { rows: [], rowCount: 0 };
    }
    if (sql.startsWith("SELECT COALESCE(MAX(version),0) AS version FROM reference_question_sets")) {
      const [orgId, personaId] = params;
      const versions = state.reference_question_sets
        .filter((q) => q.org_id === orgId && coalesceKey(q.persona_id) === coalesceKey(personaId))
        .map((q) => q.version);
      return { rows: [{ version: versions.length ? Math.max(...versions) : 0 }], rowCount: 1 };
    }
    if (sql.startsWith("INSERT INTO reference_question_sets (org_id, persona_id, name, questions, version, active, created_by) VALUES ($1,$2,$3,$4,$5,true,$6)")) {
      const [orgId, personaId, name, questionsJson, version, createdBy] = params;
      const row = {
        question_set_id: `00000000-0000-0000-1001-${String(qsSeq++).padStart(12, "0")}`,
        org_id: orgId,
        persona_id: personaId,
        name,
        questions: JSON.parse(questionsJson),
        version,
        active: true,
        created_by: createdBy,
        created_at: new Date().toISOString(),
      };
      state.reference_question_sets.push(row);
      return { rows: [row], rowCount: 1 };
    }
    if (sql.startsWith("SELECT * FROM reference_question_sets WHERE question_set_id=$1")) {
      const [id] = params;
      const rows = state.reference_question_sets.filter((q) => q.question_set_id === id);
      return { rows, rowCount: rows.length };
    }

    // ---- reference_requests ----
    if (sql.startsWith("INSERT INTO reference_requests")) {
      const [orgId, candidateId, refereeEmail, refereePhone, personaId, questionSetId, token, expiresAt, createdBy] = params;
      const row = {
        request_id: `00000000-0000-0000-1002-${String(reqSeq++).padStart(12, "0")}`,
        org_id: orgId,
        candidate_id: candidateId,
        referee_email: refereeEmail,
        referee_phone: refereePhone,
        persona_id: personaId,
        question_set_id: questionSetId,
        status: "PENDING",
        token,
        expires_at: expiresAt,
        created_by: createdBy,
        created_at: new Date().toISOString(),
        sent_at: null,
        reminder_count: 0,
        completed_at: null,
      };
      state.reference_requests.push(row);
      return { rows: [row], rowCount: 1 };
    }
    if (sql.startsWith("UPDATE reference_requests SET status='SENT', sent_at=now() WHERE request_id=$1")) {
      const [id] = params;
      const row = state.reference_requests.find((r) => r.request_id === id);
      if (row) {
        row.status = "SENT";
        row.sent_at = new Date().toISOString();
      }
      return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
    }
    if (sql.startsWith("SELECT * FROM reference_requests WHERE token=$1")) {
      const [token] = params;
      const rows = state.reference_requests.filter((r) => r.token === token);
      return { rows, rowCount: rows.length };
    }
    if (sql.startsWith("UPDATE reference_requests SET status='EXPIRED' WHERE request_id=$1")) {
      const [id] = params;
      const row = state.reference_requests.find((r) => r.request_id === id);
      if (row) row.status = "EXPIRED";
      return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
    }
    if (sql.startsWith("UPDATE reference_requests SET status='COMPLETED', completed_at=now() WHERE request_id=$1")) {
      const [id] = params;
      const row = state.reference_requests.find((r) => r.request_id === id);
      if (row) {
        row.status = "COMPLETED";
        row.completed_at = new Date().toISOString();
      }
      return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
    }
    if (sql.startsWith("SELECT * FROM reference_requests WHERE request_id=$1 AND org_id=$2")) {
      const [id, orgId] = params;
      const rows = state.reference_requests.filter((r) => r.request_id === id && r.org_id === orgId);
      return { rows, rowCount: rows.length };
    }
    if (sql.startsWith("SELECT r.*, res.result_id")) {
      const [candidateId, orgId] = params;
      const rows = state.reference_requests
        .filter((r) => r.candidate_id === candidateId && r.org_id === orgId)
        .sort((a, b) => b.created_at.localeCompare(a.created_at))
        .map((r) => {
          const res = state.reference_results.find((x) => x.request_id === r.request_id);
          return {
            ...r,
            result_id: res?.result_id ?? null,
            total_score: res?.total_score ?? null,
            max_score: res?.max_score ?? null,
            recommendation: res?.recommendation ?? null,
            review_decision: res?.review_decision ?? null,
            reviewed_at: res?.reviewed_at ?? null,
          };
        });
      return { rows, rowCount: rows.length };
    }

    // ---- reference_responses ----
    if (sql.startsWith("INSERT INTO reference_responses (request_id, question_id, response_text) VALUES ($1,$2,$3)")) {
      const [requestId, questionId, responseText] = params;
      let row = state.reference_responses.find((r) => r.request_id === requestId && r.question_id === questionId);
      if (row) {
        row.response_text = responseText;
      } else {
        row = {
          response_id: `00000000-0000-0000-1003-${String(respSeq++).padStart(12, "0")}`,
          request_id: requestId,
          question_id: questionId,
          response_text: responseText,
          score: null,
          confidence: null,
          reason_code: null,
          reason_description: null,
          evidence: {},
          created_at: new Date().toISOString(),
        };
        state.reference_responses.push(row);
      }
      return { rows: [row], rowCount: 1 };
    }
    if (sql.startsWith("INSERT INTO reference_responses (request_id, question_id, response_text, score, confidence, reason_code, reason_description, evidence)")) {
      const [requestId, questionId, responseText, score, confidence, reasonCode, reasonDescription, evidenceJson] = params;
      let row = state.reference_responses.find((r) => r.request_id === requestId && r.question_id === questionId);
      const evidence = JSON.parse(evidenceJson);
      if (row) {
        Object.assign(row, { response_text: responseText, score, confidence, reason_code: reasonCode, reason_description: reasonDescription, evidence });
      } else {
        row = {
          response_id: `00000000-0000-0000-1003-${String(respSeq++).padStart(12, "0")}`,
          request_id: requestId,
          question_id: questionId,
          response_text: responseText,
          score,
          confidence,
          reason_code: reasonCode,
          reason_description: reasonDescription,
          evidence,
          created_at: new Date().toISOString(),
        };
        state.reference_responses.push(row);
      }
      return { rows: [row], rowCount: 1 };
    }
    if (sql.startsWith("SELECT * FROM reference_responses WHERE request_id=$1")) {
      const [requestId] = params;
      const rows = state.reference_responses.filter((r) => r.request_id === requestId);
      return { rows, rowCount: rows.length };
    }

    // ---- reference_results ----
    if (sql.startsWith("INSERT INTO reference_results")) {
      const [requestId, candidateId, orgId, totalScore, maxScore, recommendation, reasonCode, reasonDescription, evidenceJson] = params;
      let row = state.reference_results.find((r) => r.request_id === requestId);
      const evidence = JSON.parse(evidenceJson);
      if (row) {
        Object.assign(row, {
          total_score: totalScore,
          max_score: maxScore,
          recommendation,
          reason_code: reasonCode,
          reason_description: reasonDescription,
          evidence,
        });
      } else {
        row = {
          result_id: `00000000-0000-0000-1004-${String(resultSeq++).padStart(12, "0")}`,
          request_id: requestId,
          candidate_id: candidateId,
          org_id: orgId,
          total_score: totalScore,
          max_score: maxScore,
          recommendation,
          reason_code: reasonCode,
          reason_description: reasonDescription,
          evidence,
          reviewer_id: null,
          review_decision: null,
          review_reason: null,
          created_at: new Date().toISOString(),
          reviewed_at: null,
        };
        state.reference_results.push(row);
      }
      return { rows: [row], rowCount: 1 };
    }
    if (sql.startsWith("SELECT * FROM reference_results WHERE result_id=$1 AND org_id=$2")) {
      const [id, orgId] = params;
      const rows = state.reference_results.filter((r) => r.result_id === id && r.org_id === orgId);
      return { rows, rowCount: rows.length };
    }
    if (sql.startsWith("UPDATE reference_results SET reviewer_id=$1")) {
      const [reviewerId, decision, reason, id] = params;
      const row = state.reference_results.find((r) => r.result_id === id);
      if (row) {
        row.reviewer_id = reviewerId;
        row.review_decision = decision;
        row.review_reason = reason;
        row.reviewed_at = new Date().toISOString();
      }
      return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
    }

    // ---- audit ----
    if (sql.startsWith("INSERT INTO audit_log")) {
      state.audit_log.push({ id: auditSeq++, params });
      return { rows: [], rowCount: 1 };
    }

    throw new Error(`Fake reference DB: unhandled query: ${sql}`);
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
