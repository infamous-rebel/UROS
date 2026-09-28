import { db } from "../../database/client";
import { logAudit } from "../../utils/audit_helper";
import { getCredential } from "../../services/integrations/credential_store";
import { evaluateFit } from "../persona_agent";
import { PersonaRequirement } from "../../models/hr.model";
import { logger } from "../../utils/logger";

interface GapFinding {
  gap_type: string;
  persona_id: string | null;
  suggestion: string;
}

const KPI_LOW_SCORE_THRESHOLD = 70;

/** Deterministic template — the decision (what gap exists) is always rule-based; only the wording may optionally be improved via BYOK. */
function deterministicSuggestion(gapType: string, context: Record<string, unknown>): string {
  if (gapType === "KPI_BELOW_TARGET") {
    return `Latest KPI score (${context.score}) is below the ${KPI_LOW_SCORE_THRESHOLD} target band. Recommend a structured performance improvement check-in and role-relevant skills training.`;
  }
  return `Persona requirement "${context.field_path}" is not currently met. Recommend targeted training or mentorship to close this gap before the next review cycle.`;
}

/**
 * Optional BYOK-driven rephrasing of an already-deterministic suggestion.
 * The gap detection and existence of a suggestion are never delegated to
 * the LLM — only its wording, and only if the org has configured a
 * credential. Falls back silently to the deterministic text on any
 * failure or if unconfigured — the recommendation is never blocked on it.
 */
async function maybeRephraseWithLlm(orgId: string, deterministicText: string): Promise<{ text: string; source: "DETERMINISTIC" | "LLM_BYOK" }> {
  const cred = await getCredential(orgId, "llm", "default").catch(() => null);
  if (!cred) return { text: deterministicText, source: "DETERMINISTIC" };

  try {
    const res = await fetch(`${cred.baseUrl ?? "https://api.openai.com/v1"}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${cred.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        messages: [{ role: "user", content: `Rephrase this HR development recommendation more warmly, keep the same meaning, one sentence: ${deterministicText}` }],
      }),
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) throw new Error(`LLM rephrase failed: ${res.status}`);
    const body = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const text = body.choices?.[0]?.message?.content?.trim();
    return text ? { text, source: "LLM_BYOK" } : { text: deterministicText, source: "DETERMINISTIC" };
  } catch (err) {
    logger.warn("IMPROVEMENT_LLM_REPHRASE_FAILED", { error: err instanceof Error ? err.message : String(err) });
    return { text: deterministicText, source: "DETERMINISTIC" };
  }
}

/** Compares latest approved KPI score and (optionally) persona fit for an employee, generating suggestions. Never auto-assigns; manager approves, HR assigns. */
export async function identifyGaps(orgId: string, employeeId: string, actorUserId: string): Promise<string[]> {
  const findings: GapFinding[] = [];

  const kpiRes = await db.query<{ approved_score: number | null; calculated_score: number }>(
    `SELECT approved_score, calculated_score FROM kpi_scores
     WHERE employee_id=$1 AND status='APPROVED'
     ORDER BY approved_at DESC LIMIT 1`,
    [employeeId]
  );
  const kpiRow = kpiRes.rows[0];
  const effectiveScore = kpiRow?.approved_score ?? kpiRow?.calculated_score;
  if (effectiveScore !== undefined && effectiveScore !== null && effectiveScore < KPI_LOW_SCORE_THRESHOLD) {
    findings.push({
      gap_type: "KPI_BELOW_TARGET",
      persona_id: null,
      suggestion: deterministicSuggestion("KPI_BELOW_TARGET", { score: effectiveScore }),
    });
  }

  const employeeRes = await db.query(`SELECT * FROM employees WHERE employee_id=$1`, [employeeId]);
  const employee = employeeRes.rows[0];
  if (employee?.department && employee?.position) {
    const personaRes = await db.query(
      `SELECT * FROM personas WHERE org_id=$1 AND department=$2 AND active=true ORDER BY version DESC LIMIT 1`,
      [orgId, employee.department]
    );
    const persona = personaRes.rows[0];
    if (persona) {
      const reqRes = await db.query<PersonaRequirement>(`SELECT * FROM persona_requirements WHERE persona_id=$1`, [persona.persona_id]);
      const fit = evaluateFit(employee, reqRes.rows);
      for (const field of fit.unmatched) {
        findings.push({
          gap_type: "PERSONA_REQUIREMENT_GAP",
          persona_id: persona.persona_id,
          suggestion: deterministicSuggestion("PERSONA_REQUIREMENT_GAP", { field_path: field }),
        });
      }
    }
  }

  const suggestionIds: string[] = [];
  for (const finding of findings) {
    const { text, source } = await maybeRephraseWithLlm(orgId, finding.suggestion);
    const result = await db.query<{ suggestion_id: string }>(
      `INSERT INTO improvement_suggestions (org_id, employee_id, persona_id, gap_type, suggestion, source)
       VALUES ($1,$2,$3,$4,$5,$6)
       RETURNING suggestion_id`,
      [orgId, employeeId, finding.persona_id, finding.gap_type, text, source]
    );
    suggestionIds.push(result.rows[0].suggestion_id);

    await logAudit({
      entity_type: "IMPROVEMENT_SUGGESTION",
      entity_id: result.rows[0].suggestion_id,
      agent_or_user: actorUserId,
      action: "SUGGESTION_GENERATED",
      output_value: { gap_type: finding.gap_type, source },
    });
  }

  return suggestionIds;
}
