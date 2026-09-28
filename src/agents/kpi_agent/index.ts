import { db } from "../../database/client";
import { logAudit } from "../../utils/audit_helper";
import { KpiDefinition } from "../../models/hr.model";

export interface KpiComputeResult {
  score: number;
  breakdown: Record<string, number>;
  band: string | null;
}

/**
 * Deterministic weighted-sum KPI calculation:
 *   score = Σ (input_metrics[metric_field] × weight / 100)
 * Each metric is expected as a 0–100 value (e.g. "Sales Target Achieved: 85").
 * No hidden model — every term is visible in `breakdown`.
 */
export function computeScore(
  formula: KpiDefinition["formula"],
  inputMetrics: Record<string, number>,
  bandThresholds: Record<string, number> | null
): KpiComputeResult {
  const breakdown: Record<string, number> = {};
  let total = 0;

  for (const term of formula) {
    const value = inputMetrics[term.metric_field] ?? 0;
    const contribution = Math.round(((value * term.weight) / 100) * 100) / 100;
    breakdown[term.metric_field] = contribution;
    total += contribution;
  }

  const score = Math.round(total * 100) / 100;
  let band: string | null = null;
  if (bandThresholds) {
    const sorted = Object.entries(bandThresholds).sort((a, b) => b[1] - a[1]);
    for (const [label, threshold] of sorted) {
      if (score >= threshold) { band = label; break; }
    }
  }

  return { score, breakdown, band };
}

/**
 * Runs the calculation and persists a CALCULATED score, ready for
 * manager approval.
 *
 * Security Hardening Round: orgId is now mandatory. kpi_scores has no
 * org_id column of its own — org membership is validated here via
 * kpi_id -> kpi_definitions.org_id and employee_id -> employees.org_id
 * before any read/write, so a caller can no longer compute (and, since
 * this is an upsert, overwrite) a KPI score using another org's KPI
 * definition or for another org's employee.
 */
export async function calculateAndStoreScore(
  kpiId: string,
  employeeId: string,
  period: string,
  inputMetrics: Record<string, number>,
  orgId: string,
  actorUserId: string
): Promise<string> {
  const defRes = await db.query<KpiDefinition>(`SELECT * FROM kpi_definitions WHERE kpi_id=$1 AND org_id=$2`, [kpiId, orgId]);
  if (defRes.rowCount === 0) throw new Error(`KPI definition not found: ${kpiId}`);
  const definition = defRes.rows[0];

  const employeeRes = await db.query(`SELECT employee_id FROM employees WHERE employee_id=$1 AND org_id=$2`, [employeeId, orgId]);
  if (employeeRes.rowCount === 0) throw new Error(`Employee not found: ${employeeId}`);

  const { score, breakdown, band } = computeScore(definition.formula, inputMetrics, definition.band_thresholds);

  const result = await db.query<{ score_id: string }>(
    `INSERT INTO kpi_scores (kpi_id, employee_id, period, input_metrics, calculated_score, breakdown, band)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (kpi_id, employee_id, period) DO UPDATE SET
       input_metrics=EXCLUDED.input_metrics, calculated_score=EXCLUDED.calculated_score,
       breakdown=EXCLUDED.breakdown, band=EXCLUDED.band, status='CALCULATED',
       calculated_at=now(), approved_score=NULL, approved_at=NULL
     RETURNING score_id`,
    [kpiId, employeeId, period, JSON.stringify(inputMetrics), score, JSON.stringify(breakdown), band]
  );

  await logAudit({
    entity_type: "KPI_SCORE",
    entity_id: result.rows[0].score_id,
    agent_or_user: actorUserId,
    action: "KPI_CALCULATED",
    output_value: { kpi_id: kpiId, employee_id: employeeId, period, score, band },
  });

  return result.rows[0].score_id;
}
