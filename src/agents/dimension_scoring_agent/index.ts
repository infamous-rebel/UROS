import { PoolClient } from "pg";
import { db } from "../../database/client";
import { applyOperator } from "../../rules/engine/operators";
import { logAudit } from "../../utils/audit_helper";
import { env } from "../../config/env.schema";
import {
  CandidateDimensionProfile,
  AcademicLevelProfile,
  DimensionConfig,
  DimensionSubcriterion,
  DimensionBreakdownEntry,
  SubcriterionEvidence,
  DimensionRecommendedDecision,
} from "../../models/dimension.model";

/**
 * Assembles a flat, deterministic candidate profile from tables that
 * already exist (candidates, candidate_academic_records,
 * candidate_experience, candidate_quota, candidate_documents). Dimension
 * sub-criteria field_paths are dotted paths into exactly this object —
 * no phantom tables, no inferred fields.
 */
export async function assembleCandidateProfile(
  candidateId: string,
  orgId: string
): Promise<CandidateDimensionProfile> {
  const [candidateRes, academicRes, experienceRes, quotaRes, documentsRes] = await Promise.all([
    db.query(`SELECT * FROM candidates WHERE candidate_id=$1 AND org_id=$2`, [candidateId, orgId]),
    db.query(`SELECT * FROM candidate_academic_records WHERE candidate_id=$1`, [candidateId]),
    db.query(`SELECT * FROM candidate_experience WHERE candidate_id=$1`, [candidateId]),
    db.query(`SELECT * FROM candidate_quota WHERE candidate_id=$1`, [candidateId]),
    db.query(`SELECT * FROM candidate_documents WHERE candidate_id=$1`, [candidateId]),
  ]);

  if (candidateRes.rowCount === 0) {
    throw new Error(`Candidate not found: ${candidateId}`);
  }
  const candidate = candidateRes.rows[0];

  const academic: Record<string, AcademicLevelProfile> = {};
  const educationRank = ["ssc", "diploma", "hsc", "bachelor", "masters", "other"];
  let highestLevel: string | null = null;
  let highestCgpa: number | null = null;

  for (const row of academicRes.rows) {
    const levelKey = String(row.level ?? "other").toLowerCase();
    academic[levelKey] = {
      cgpa: row.cgpa !== null ? Number(row.cgpa) : null,
      division_class: row.division_class ?? null,
      passing_year: row.passing_year ?? null,
      institution: row.institution ?? null,
      board_or_university: row.board_or_university ?? null,
      result_scale: row.result_scale ?? null,
      field_confidence: row.field_confidence !== null ? Number(row.field_confidence) : null,
    };
    if (!highestLevel || educationRank.indexOf(levelKey) > educationRank.indexOf(highestLevel)) {
      highestLevel = levelKey;
    }
    if (row.cgpa !== null && (highestCgpa === null || Number(row.cgpa) > highestCgpa)) {
      highestCgpa = Number(row.cgpa);
    }
  }

  const totalExperienceYears = experienceRes.rows.reduce(
    (sum: number, r: any) => sum + (r.experience_years !== null ? Number(r.experience_years) : 0),
    0
  );
  const currentExperience = experienceRes.rows.find((r: any) => r.is_current === true) ?? experienceRes.rows[0];

  const documentsTotal = documentsRes.rowCount ?? 0;
  const documentsVerified = documentsRes.rows.filter((d: any) => d.verification_status === "Verified").length;

  let ageYears: number | null = null;
  if (candidate.date_of_birth) {
    const dob = new Date(candidate.date_of_birth);
    const ageMs = Date.now() - dob.getTime();
    ageYears = Math.floor(ageMs / (1000 * 60 * 60 * 24 * 365.25));
  }

  return {
    candidate_id: candidate.candidate_id,
    full_name: candidate.full_name,
    district: candidate.district ?? null,
    division: candidate.division ?? null,
    source_platform: candidate.source_platform ?? null,
    position_applied: candidate.position_applied ?? null,
    job_circular_id: candidate.job_circular_id ?? null,
    status: candidate.status,
    age_years: ageYears,
    academic,
    highest_education_level: highestLevel
      ? highestLevel.charAt(0).toUpperCase() + highestLevel.slice(1)
      : null,
    highest_cgpa: highestCgpa,
    total_experience_years: Math.round(totalExperienceYears * 10) / 10,
    experience_count: experienceRes.rowCount ?? 0,
    current_organization: currentExperience?.organization ?? null,
    current_designation: currentExperience?.designation ?? null,
    quota: {
      quota_type: quotaRes.rows[0]?.quota_type ?? null,
      applied_quota_flag: quotaRes.rows[0]?.applied_quota_flag ?? false,
    },
    documents_total: documentsTotal,
    documents_verified: documentsVerified,
    documents_verified_ratio: documentsTotal > 0 ? Math.round((documentsVerified / documentsTotal) * 100) / 100 : 0,
  };
}

/** Reads a dotted field path from the assembled profile (same walk semantics as the eligibility evaluator). */
function extractField(profile: CandidateDimensionProfile, path: string): unknown {
  const segments = path.split(".");
  let node: any = profile;
  for (const segment of segments) {
    if (node === null || node === undefined) return null;
    node = node[segment];
  }
  return node === undefined ? null : node;
}

/** Confidence for academic.<level>.* paths comes from that academic record's field_confidence; everything else is treated as High (structured, human-corrected data). */
function extractConfidence(profile: CandidateDimensionProfile, path: string): number | null {
  const segments = path.split(".");
  if (segments[0] === "academic" && segments.length >= 2) {
    const level = profile.academic[segments[1]];
    return level ? level.field_confidence : null;
  }
  return null;
}

function evaluateSubcriterion(
  profile: CandidateDimensionProfile,
  sub: DimensionSubcriterion,
  normalizedWeight: number
): SubcriterionEvidence {
  const extractedValue = extractField(profile, sub.field_path);
  const confidence = extractConfidence(profile, sub.field_path);

  const base = {
    subcriterion_id: sub.subcriterion_id,
    field_path: sub.field_path,
    label: sub.label,
    operator: sub.operator,
    threshold_value: sub.threshold_value,
    extracted_value: extractedValue,
    confidence,
    weight: sub.weight,
    evidence_doc_type: sub.evidence_doc_type,
  };

  if (extractedValue === null || extractedValue === undefined) {
    return { ...base, matched: false, flagged: true, flag_reason: "MISSING_FIELD", points_earned: 0, reason_code: sub.reason_code };
  }

  if (confidence !== null && confidence < env.DEFAULT_OCR_CONFIDENCE_THRESHOLD) {
    return { ...base, matched: false, flagged: true, flag_reason: "LOW_CONFIDENCE", points_earned: 0, reason_code: sub.reason_code };
  }

  let matched: boolean;
  try {
    matched = applyOperator(extractedValue, sub.operator, sub.threshold_value);
  } catch {
    // A RuleEvaluationError here means the extracted value's type/shape
    // couldn't be evaluated against this operator (e.g. non-numeric value
    // for GTE) — treat exactly like a missing field: flag for review,
    // never silently guess a pass/fail.
    return { ...base, matched: false, flagged: true, flag_reason: "MISSING_FIELD", points_earned: 0, reason_code: sub.reason_code };
  }

  return {
    ...base,
    matched,
    flagged: false,
    flag_reason: null,
    points_earned: matched ? Math.round(normalizedWeight * 100) / 100 : 0,
    reason_code: matched ? null : sub.reason_code,
  };
}

export interface DimensionScoringInput {
  dimension_configs: DimensionConfig[];
  subcriteria_by_config: Record<string, DimensionSubcriterion[]>;
}

export interface DimensionScoringOutput {
  overall_fit_score: number;
  dimension_breakdown: DimensionBreakdownEntry[];
  recommended_decision: DimensionRecommendedDecision;
  knockout_triggered: boolean;
  knockout_reason: string | null;
}

/**
 * Pure, deterministic scoring function: same (profile, configs) always
 * yields the same output. No model, no randomness, no external calls.
 * - Each dimension's sub-criteria weights are normalized to 100 within
 *   that dimension (mirrors persona_agent.evaluateFit).
 * - Each dimension's raw_score (0-100) is the sum of earned points.
 * - Dimension weights are normalized to 100 across all active dimensions
 *   to produce overall_fit_score, so partial dimension sets still yield
 *   a comparable 0-100 score.
 * - A knockout dimension whose raw_score falls below its
 *   knockout_threshold fails the whole candidate (AUTO_FAIL), regardless
 *   of overall_fit_score — mirrors the rule engine's knockout semantics.
 * - Any flagged sub-criterion (missing field / low confidence) anywhere
 *   forces NEEDS_REVIEW instead of AUTO_PASS — the system never silently
 *   guesses past incomplete or unreliable data.
 */
export function scoreDimensions(
  profile: CandidateDimensionProfile,
  input: DimensionScoringInput
): DimensionScoringOutput {
  const configs = input.dimension_configs.filter((c) => c.active).sort((a, b) => a.sequence - b.sequence);
  const totalDimensionWeight = configs.reduce((sum, c) => sum + c.weight, 0) || 1;

  const breakdown: DimensionBreakdownEntry[] = [];
  let overall = 0;
  let anyFlagged = false;
  let knockoutTriggered = false;
  let knockoutReason: string | null = null;

  for (const config of configs) {
    const subcriteria = (input.subcriteria_by_config[config.dimension_config_id] ?? []).filter((s) => s.active);
    const totalSubWeight = subcriteria.reduce((sum, s) => sum + s.weight, 0) || 1;

    const evidence: SubcriterionEvidence[] = subcriteria.map((sub) =>
      evaluateSubcriterion(profile, sub, (sub.weight / totalSubWeight) * 100)
    );

    const rawScore = Math.round(evidence.reduce((sum, e) => sum + e.points_earned, 0) * 100) / 100;
    const normalizedDimensionWeight = (config.weight / totalDimensionWeight) * 100;
    const weightedScore = Math.round(((rawScore * normalizedDimensionWeight) / 100) * 100) / 100;

    const knockoutFailed = config.is_knockout && config.knockout_threshold !== null && rawScore < config.knockout_threshold;
    if (knockoutFailed) {
      knockoutTriggered = true;
      knockoutReason = knockoutReason
        ? `${knockoutReason}; ${config.dimension_name} scored ${rawScore} (below knockout threshold ${config.knockout_threshold})`
        : `${config.dimension_name} scored ${rawScore} (below knockout threshold ${config.knockout_threshold})`;
    }
    if (evidence.some((e) => e.flagged)) {
      anyFlagged = true;
    }

    overall += weightedScore;

    breakdown.push({
      dimension_config_id: config.dimension_config_id,
      dimension_key: config.dimension_key,
      dimension_name: config.dimension_name,
      sequence: config.sequence,
      weight: config.weight,
      raw_score: rawScore,
      weighted_score: weightedScore,
      is_knockout: config.is_knockout,
      knockout_threshold: config.knockout_threshold,
      knockout_failed: knockoutFailed,
      subcriteria: evidence,
    });
  }

  const overallFitScore = Math.round(overall * 100) / 100;

  let recommendedDecision: DimensionRecommendedDecision;
  if (knockoutTriggered) {
    recommendedDecision = "AUTO_FAIL";
  } else if (anyFlagged) {
    recommendedDecision = "NEEDS_REVIEW";
  } else {
    recommendedDecision = "AUTO_PASS";
  }

  return {
    overall_fit_score: overallFitScore,
    dimension_breakdown: breakdown,
    recommended_decision: recommendedDecision,
    knockout_triggered: knockoutTriggered,
    knockout_reason: knockoutReason,
  };
}

/** Loads the active dimension configuration set for an org (optionally scoped to a persona). */
async function loadActiveDimensionConfigs(
  orgId: string,
  personaId: string | null
): Promise<DimensionScoringInput> {
  const configRes = await db.query<DimensionConfig>(
    `SELECT * FROM dimension_configs
     WHERE org_id=$1 AND active=true AND (persona_id IS NOT DISTINCT FROM $2)
     ORDER BY sequence ASC`,
    [orgId, personaId]
  );
  if (configRes.rowCount === 0) {
    throw new Error(
      `No active dimension configuration found for org=${orgId}${personaId ? ` persona=${personaId}` : ""}. Configure dimensions via POST /dimensions/configure first.`
    );
  }

  const configIds = configRes.rows.map((c) => c.dimension_config_id);
  const subRes = await db.query<DimensionSubcriterion>(
    `SELECT * FROM dimension_subcriteria WHERE dimension_config_id = ANY($1::uuid[]) AND active=true`,
    [configIds]
  );

  const subcriteria_by_config: Record<string, DimensionSubcriterion[]> = {};
  for (const sub of subRes.rows) {
    (subcriteria_by_config[sub.dimension_config_id] ??= []).push(sub);
  }

  return { dimension_configs: configRes.rows, subcriteria_by_config };
}

/**
 * Full orchestration: assemble profile -> score deterministically ->
 * persist candidate_dimension_scores row -> audit. Runs inside a single
 * transaction so a partially-written score can never be observed.
 */
export async function runDimensionScoring(
  candidateId: string,
  orgId: string,
  personaId: string | null,
  actorUserId: string
): Promise<{ evaluation_id: string } & DimensionScoringOutput> {
  const profile = await assembleCandidateProfile(candidateId, orgId);
  const input = await loadActiveDimensionConfigs(orgId, personaId);
  const templateId = input.dimension_configs[0]?.template_id ?? null;
  const result = scoreDimensions(profile, input);

  const evaluationId = await db.withTransaction(async (client: PoolClient) => {
    const insertRes = await client.query(
      `INSERT INTO candidate_dimension_scores
        (candidate_id, org_id, persona_id, template_id, overall_fit_score, dimension_breakdown,
         recommended_decision, knockout_triggered, knockout_reason, computed_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       RETURNING evaluation_id`,
      [
        candidateId,
        orgId,
        personaId,
        templateId,
        result.overall_fit_score,
        JSON.stringify(result.dimension_breakdown),
        result.recommended_decision,
        result.knockout_triggered,
        result.knockout_reason,
        actorUserId === "SYSTEM_AGENT" ? "SYSTEM" : actorUserId,
      ]
    );
    return insertRes.rows[0].evaluation_id as string;
  });

  await logAudit({
    org_id: orgId,
    entity_type: "DIMENSION_SCORE",
    entity_id: evaluationId,
    agent_or_user: actorUserId,
    action: "DIMENSION_SCORE_COMPUTED",
    input_value: { candidate_id: candidateId, persona_id: personaId },
    output_value: {
      overall_fit_score: result.overall_fit_score,
      recommended_decision: result.recommended_decision,
      knockout_triggered: result.knockout_triggered,
    },
    reason_code: result.knockout_triggered ? "KNOCKOUT" : undefined,
  });

  return { evaluation_id: evaluationId, ...result };
}
