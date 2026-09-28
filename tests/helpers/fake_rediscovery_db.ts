/**
 * Minimal stateful in-memory fake for src/database/client.ts, scoped to
 * exactly the queries rediscovery_agent/index.ts, rediscovery.routes.ts,
 * dimension_scoring_agent.assembleCandidateProfile,
 * communication_agent.sendBatch, and utils/audit_helper.ts issue.
 * Dispatches on a normalized prefix of the SQL text rather than parsing
 * SQL — sufficient and honest for a fixed, known query set; not a
 * general-purpose query engine (mirrors fake_fraud_db.ts / fake_offboarding_db.ts).
 */
export interface FakeRediscoveryDbState {
  organizations: any[];
  candidates: any[];
  candidate_academic_records: any[];
  candidate_experience: any[];
  candidate_quota: any[];
  candidate_documents: any[];
  personas: any[];
  persona_requirements: any[];
  fraud_flags: any[];
  rediscovery_consents: any[];
  rediscovery_suggestions: any[];
  rediscovery_outreach: any[];
  communication_log: any[];
  audit_log: any[];
}

let uuidSeq = 1;
function nextUuid(_prefix: string): string {
  // Valid UUID-v4-shaped IDs (zod's z.string().uuid() only checks
  // format, not real randomness) so this fake behaves like production,
  // where suggestion_id/outreach_id/consent_id are gen_random_uuid().
  const n = String(uuidSeq++).padStart(12, "0");
  return `00000000-0000-4000-8000-${n}`;
}

export function createFakeRediscoveryDb() {
  const state: FakeRediscoveryDbState = {
    organizations: [],
    candidates: [],
    candidate_academic_records: [],
    candidate_experience: [],
    candidate_quota: [],
    candidate_documents: [],
    personas: [],
    persona_requirements: [],
    fraud_flags: [],
    rediscovery_consents: [],
    rediscovery_suggestions: [],
    rediscovery_outreach: [],
    communication_log: [],
    audit_log: [],
  };

  async function query(text: string, params: any[] = []): Promise<{ rows: any[]; rowCount: number }> {
    const sql = text.replace(/\s+/g, " ").trim();

    // --- assembleCandidateProfile (dimension_scoring_agent) ---
    if (sql.startsWith("SELECT * FROM candidates WHERE candidate_id=$1 AND org_id=$2")) {
      const [candidateId, orgId] = params;
      const rows = state.candidates.filter((c) => c.candidate_id === candidateId && c.org_id === orgId);
      return { rows, rowCount: rows.length };
    }
    if (sql.startsWith("SELECT * FROM candidate_academic_records WHERE candidate_id=$1")) {
      const rows = state.candidate_academic_records.filter((r) => r.candidate_id === params[0]);
      return { rows, rowCount: rows.length };
    }
    if (sql.startsWith("SELECT * FROM candidate_experience WHERE candidate_id=$1")) {
      const rows = state.candidate_experience.filter((r) => r.candidate_id === params[0]);
      return { rows, rowCount: rows.length };
    }
    if (sql.startsWith("SELECT * FROM candidate_quota WHERE candidate_id=$1")) {
      const rows = state.candidate_quota.filter((r) => r.candidate_id === params[0]);
      return { rows, rowCount: rows.length };
    }
    if (sql.startsWith("SELECT * FROM candidate_documents WHERE candidate_id=$1")) {
      const rows = state.candidate_documents.filter((r) => r.candidate_id === params[0]);
      return { rows, rowCount: rows.length };
    }

    // --- rediscovery.routes.ts public consent path (org_id lookup) ---
    if (sql.startsWith("SELECT org_id FROM candidates WHERE candidate_id=$1")) {
      const rows = state.candidates.filter((c) => c.candidate_id === params[0]).map((c) => ({ org_id: c.org_id }));
      return { rows, rowCount: rows.length };
    }

    // --- rediscovery_agent.setRediscoveryConsent ---
    if (sql.startsWith("SELECT candidate_id FROM candidates WHERE candidate_id=$1 AND org_id=$2")) {
      const [candidateId, orgId] = params;
      const rows = state.candidates.filter((c) => c.candidate_id === candidateId && c.org_id === orgId);
      return { rows, rowCount: rows.length };
    }
    if (sql.startsWith("SELECT * FROM rediscovery_consents WHERE candidate_id=$1")) {
      const rows = state.rediscovery_consents.filter((r) => r.candidate_id === params[0]);
      return { rows, rowCount: rows.length };
    }
    if (sql.startsWith("INSERT INTO rediscovery_consents")) {
      const [candidate_id, org_id, opted_in, opted_in_at, opted_out_at] = params;
      const row = {
        consent_id: nextUuid("consent"),
        candidate_id,
        org_id,
        opted_in,
        opted_in_at,
        opted_out_at,
        updated_at: new Date().toISOString(),
      };
      state.rediscovery_consents.push(row);
      return { rows: [row], rowCount: 1 };
    }
    if (sql.startsWith("UPDATE rediscovery_consents")) {
      const [opted_in, opted_in_at, opted_out_at, candidate_id] = params;
      const row = state.rediscovery_consents.find((r) => r.candidate_id === candidate_id);
      if (!row) return { rows: [], rowCount: 0 };
      row.opted_in = opted_in;
      row.opted_in_at = opted_in_at;
      row.opted_out_at = opted_out_at;
      row.updated_at = new Date().toISOString();
      return { rows: [row], rowCount: 1 };
    }

    // --- rediscovery_agent.getRediscoveryConsent ---
    if (sql.startsWith("SELECT c.* FROM rediscovery_consents c")) {
      const [candidateId, orgId] = params;
      const candidate = state.candidates.find((c) => c.candidate_id === candidateId && c.org_id === orgId);
      if (!candidate) return { rows: [], rowCount: 0 };
      const rows = state.rediscovery_consents.filter((r) => r.candidate_id === candidateId);
      return { rows, rowCount: rows.length };
    }

    // --- rediscovery_agent.runRediscoveryMatch ---
    if (sql.startsWith("SELECT persona_id, name FROM personas WHERE persona_id=$1 AND org_id=$2 AND active=true")) {
      const [personaId, orgId] = params;
      const rows = state.personas.filter((p) => p.persona_id === personaId && p.org_id === orgId && p.active === true);
      return { rows, rowCount: rows.length };
    }
    if (sql.startsWith("SELECT * FROM persona_requirements WHERE persona_id=$1")) {
      const rows = state.persona_requirements.filter((r) => r.persona_id === params[0]);
      return { rows, rowCount: rows.length };
    }
    if (sql.startsWith("SELECT candidate_id, status, updated_at, job_circular_id, position_applied")) {
      const [orgId, limit] = params;
      const rows = state.candidates
        .filter((c) => c.org_id === orgId && (c.status === "REJECTED" || c.status === "WITHDRAWN"))
        .sort((a, b) => (a.candidate_id < b.candidate_id ? -1 : 1))
        .slice(0, limit)
        .map((c) => ({
          candidate_id: c.candidate_id,
          status: c.status,
          updated_at: c.updated_at,
          job_circular_id: c.job_circular_id ?? null,
          position_applied: c.position_applied ?? null,
        }));
      return { rows, rowCount: rows.length };
    }
    if (sql.startsWith("SELECT candidate_id FROM rediscovery_suggestions WHERE target_circular_id=$1 AND candidate_id = ANY($2::text[])")) {
      const [circularId, ids] = params;
      const rows = state.rediscovery_suggestions
        .filter((s) => s.target_circular_id === circularId && ids.includes(s.candidate_id))
        .map((s) => ({ candidate_id: s.candidate_id }));
      return { rows, rowCount: rows.length };
    }
    if (sql.startsWith("SELECT DISTINCT candidate_id FROM fraud_flags WHERE org_id=$1")) {
      const [orgId, ids] = params;
      const openStatuses = ["OPEN", "CONFIRMED", "ESCALATED"];
      const rows = Array.from(
        new Set(
          state.fraud_flags
            .filter((f) => f.org_id === orgId && openStatuses.includes(f.status) && ids.includes(f.candidate_id))
            .map((f) => f.candidate_id)
        )
      ).map((candidate_id) => ({ candidate_id }));
      return { rows, rowCount: rows.length };
    }
    if (sql.startsWith("SELECT candidate_id, opted_in FROM rediscovery_consents WHERE candidate_id = ANY($1::text[])")) {
      const [ids] = params;
      const rows = state.rediscovery_consents
        .filter((r) => ids.includes(r.candidate_id))
        .map((r) => ({ candidate_id: r.candidate_id, opted_in: r.opted_in }));
      return { rows, rowCount: rows.length };
    }
    if (sql.startsWith("INSERT INTO rediscovery_suggestions")) {
      const [org_id, candidate_id, target_circular_id, target_position, fit_score, reason_code, reason_description, evidence] = params;
      const row = {
        suggestion_id: nextUuid("suggestion"),
        org_id,
        candidate_id,
        target_circular_id,
        target_position,
        fit_score,
        reason_code,
        reason_description,
        evidence: JSON.parse(evidence),
        status: "PENDING_REVIEW",
        created_at: new Date().toISOString(),
        reviewed_by: null,
        reviewed_at: null,
        review_reason: null,
      };
      state.rediscovery_suggestions.push(row);
      return { rows: [row], rowCount: 1 };
    }

    // --- rediscovery_agent.listRediscoverySuggestions ---
    if (sql.startsWith("SELECT * FROM rediscovery_suggestions WHERE org_id=$1")) {
      const orgId = params[0];
      let rows = state.rediscovery_suggestions.filter((s) => s.org_id === orgId);
      // Generic filter application based on which extra params were bound
      // (mirrors the conditions array built in listRediscoverySuggestions).
      let pIdx = 1;
      if (sql.includes("target_circular_id=$")) {
        pIdx += 1;
        rows = rows.filter((s) => s.target_circular_id === params[pIdx - 1]);
      }
      if (sql.includes("status=$")) {
        pIdx += 1;
        rows = rows.filter((s) => s.status === params[pIdx - 1]);
      }
      rows = rows.slice().sort((a, b) => b.fit_score - a.fit_score || (a.created_at < b.created_at ? -1 : 1));
      const limit = params[params.length - 2];
      const offset = params[params.length - 1];
      const paged = rows.slice(offset, offset + limit);
      return { rows: paged, rowCount: rows.length };
    }

    // --- rediscovery_agent.reviewSuggestion ---
    if (sql.startsWith("SELECT * FROM rediscovery_suggestions WHERE suggestion_id=$1 AND org_id=$2")) {
      const [suggestionId, orgId] = params;
      const rows = state.rediscovery_suggestions.filter((s) => s.suggestion_id === suggestionId && s.org_id === orgId);
      return { rows, rowCount: rows.length };
    }
    if (sql.startsWith("UPDATE rediscovery_suggestions")) {
      const [status, reviewed_by, review_reason, suggestion_id] = params;
      const row = state.rediscovery_suggestions.find((s) => s.suggestion_id === suggestion_id);
      if (!row) return { rows: [], rowCount: 0 };
      row.status = status;
      row.reviewed_by = reviewed_by;
      row.reviewed_at = new Date().toISOString();
      row.review_reason = review_reason;
      return { rows: [row], rowCount: 1 };
    }

    // --- rediscovery_agent.sendOutreachBatch ---
    if (sql.startsWith("SELECT opted_in FROM rediscovery_consents WHERE candidate_id=$1")) {
      const rows = state.rediscovery_consents.filter((r) => r.candidate_id === params[0]).map((r) => ({ opted_in: r.opted_in }));
      return { rows, rowCount: rows.length };
    }
    if (sql.startsWith("INSERT INTO rediscovery_outreach")) {
      const [suggestion_id, channel, template_code] = params;
      const row = {
        outreach_id: nextUuid("outreach"),
        suggestion_id,
        channel,
        template_code,
        status: "SENT",
        sent_at: new Date().toISOString(),
        response_status: "PENDING",
        responded_at: null,
      };
      state.rediscovery_outreach.push(row);
      return { rows: [row], rowCount: 1 };
    }

    // --- rediscovery_agent.listRediscoveryOutreach ---
    if (sql.startsWith("SELECT o.*, s.candidate_id, s.target_circular_id")) {
      const orgId = params[0];
      const suggestionsById = new Map(state.rediscovery_suggestions.map((s) => [s.suggestion_id, s]));
      let rows = state.rediscovery_outreach
        .map((o) => ({ o, s: suggestionsById.get(o.suggestion_id) }))
        .filter((pair) => pair.s && pair.s.org_id === orgId)
        .map((pair) => ({ ...pair.o, candidate_id: pair.s.candidate_id, target_circular_id: pair.s.target_circular_id }));

      let pIdx = 1;
      if (sql.includes("o.suggestion_id=$")) {
        pIdx += 1;
        rows = rows.filter((r) => r.suggestion_id === params[pIdx - 1]);
      }
      if (sql.includes("s.target_circular_id=$")) {
        pIdx += 1;
        rows = rows.filter((r) => r.target_circular_id === params[pIdx - 1]);
      }
      rows = rows.slice().sort((a, b) => (a.sent_at < b.sent_at ? 1 : -1));
      const limit = params[params.length - 2];
      const offset = params[params.length - 1];
      const paged = rows.slice(offset, offset + limit);
      return { rows: paged, rowCount: rows.length };
    }

    // --- communication_agent.sendBatch ---
    if (sql.startsWith("SELECT default_language FROM organizations WHERE org_id=$1")) {
      const rows = state.organizations.filter((o) => o.org_id === params[0]);
      return { rows, rowCount: rows.length };
    }
    if (sql.startsWith("INSERT INTO communication_log")) {
      const [candidate_id, channel, template_code, language] = params;
      state.communication_log.push({ candidate_id, channel, template_code, status: "SENT", language });
      return { rows: [], rowCount: 1 };
    }

    // --- audit_helper.logAudit ---
    if (sql.startsWith("INSERT INTO audit_log")) {
      state.audit_log.push({ id: nextUuid("audit"), params });
      return { rows: [], rowCount: 1 };
    }

    throw new Error(`fake_rediscovery_db: unhandled query: ${sql}`);
  }

  return {
    state,
    db: { query, withTransaction: async (fn: any) => fn({ query }) },
  };
}
