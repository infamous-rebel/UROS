import { db } from "../../database/client";
import { applyOperator } from "../../rules/engine/operators";
import { logAudit } from "../../utils/audit_helper";
import { PersonaRequirement } from "../../models/hr.model";

export interface PersonaFitResult {
  fit_score: number; // 0-100
  breakdown: Record<string, number>;
  matched: string[];
  unmatched: string[];
}

function extractField(obj: Record<string, unknown>, path: string): unknown {
  return path.split(".").reduce<any>((node, seg) => (node == null ? null : node[seg]), obj);
}

/**
 * Evaluates a candidate/employee profile against a persona's requirements
 * using the same deterministic operator set as the eligibility rule engine
 * (no separate scoring logic to keep behavior consistent and explainable).
 * Total weight is normalized to 100 regardless of how requirement weights
 * were entered, so `fit_score` is always comparable across personas.
 */
export function evaluateFit(profile: Record<string, unknown>, requirements: PersonaRequirement[]): PersonaFitResult {
  const totalWeight = requirements.reduce((sum, r) => sum + r.weight, 0) || 1;
  const breakdown: Record<string, number> = {};
  const matched: string[] = [];
  const unmatched: string[] = [];
  let earned = 0;

  for (const req of requirements) {
    const value = extractField(profile, req.field_path);
    let isMatch = false;
    if (value !== null && value !== undefined) {
      try {
        isMatch = applyOperator(value, req.operator, req.value);
      } catch {
        isMatch = false;
      }
    }
    const points = isMatch ? (req.weight / totalWeight) * 100 : 0;
    breakdown[req.field_path] = Math.round(points * 100) / 100;
    earned += points;
    (isMatch ? matched : unmatched).push(req.field_path);
  }

  return { fit_score: Math.round(earned * 100) / 100, breakdown, matched, unmatched };
}

/**
 * Security Hardening Round: orgId is now mandatory and validated before
 * the requirements are read — previously any authenticated recruiter
 * role could evaluate a profile against another org's persona,
 * leaking that org's requirement weighting scheme (persona_requirements
 * has no org_id column of its own; personas.org_id is the source of
 * truth).
 */
export async function evaluatePersonaForEmployee(
  personaId: string,
  employeeId: string,
  profile: Record<string, unknown>,
  orgId: string,
  actorUserId: string
): Promise<PersonaFitResult> {
  const personaRes = await db.query(`SELECT persona_id FROM personas WHERE persona_id=$1 AND org_id=$2`, [personaId, orgId]);
  if (personaRes.rowCount === 0) throw new Error(`Persona not found: ${personaId}`);

  const reqRes = await db.query<PersonaRequirement>(
    `SELECT * FROM persona_requirements WHERE persona_id=$1`,
    [personaId]
  );
  const result = evaluateFit(profile, reqRes.rows);

  await logAudit({
    entity_type: "PERSONA_EVALUATION",
    entity_id: employeeId,
    agent_or_user: actorUserId,
    action: "PERSONA_FIT_EVALUATED",
    output_value: { persona_id: personaId, fit_score: result.fit_score, unmatched: result.unmatched },
  });

  return result;
}
