import { Request, Response, NextFunction } from "express";
import { db } from "../../database/client";

/**
 * Security Hardening Round: reusable tenant-isolation primitive.
 *
 * Every lookup returns 404 (never 403) on an org mismatch, matching the
 * existing convention in fraud.routes.ts/candidates.routes.ts: a 403
 * confirms to an attacker that the resource exists in another org; a
 * 404 does not.
 */
export type TenantLookup = (resourceId: string, orgId: string) => Promise<boolean>;

/**
 * Express middleware factory. Verifies that `req.params[paramName]`
 * belongs to `req.user.org_id` via the supplied lookup before calling
 * next(). Must run after `authenticate`.
 */
export function validateTenantAccess(paramName: string, lookup: TenantLookup, notFoundMessage = "Resource not found") {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    if (!req.user) {
      res.status(401).json({ error: "Authentication required" });
      return;
    }
    const resourceId = req.params[paramName];
    if (!resourceId) {
      res.status(400).json({ error: `Missing route parameter: ${paramName}` });
      return;
    }
    try {
      const belongs = await lookup(resourceId, req.user.org_id);
      if (!belongs) {
        res.status(404).json({ error: notFoundMessage });
        return;
      }
      next();
    } catch (err) {
      next(err);
    }
  };
}

async function existsQuery(sql: string, params: unknown[]): Promise<boolean> {
  const res = await db.query(sql, params);
  return (res.rowCount ?? 0) > 0;
}

/**
 * Reusable org-ownership lookups for resources referenced by id across
 * routes whose owning table has no direct org_id column and must be
 * scoped via a join. Each is also usable directly inside a handler
 * (not just via validateTenantAccess) where a route needs the checked
 * id for more than routing (e.g. to reuse it in a follow-up query).
 */
export const tenantLookups: Record<string, TenantLookup> = {
  candidate: (candidateId, orgId) => existsQuery(`SELECT 1 FROM candidates WHERE candidate_id=$1 AND org_id=$2`, [candidateId, orgId]),

  appeal: (appealId, orgId) =>
    existsQuery(
      `SELECT 1 FROM appeals a JOIN candidates c ON c.candidate_id = a.candidate_id WHERE a.appeal_id=$1 AND c.org_id=$2`,
      [appealId, orgId]
    ),

  evaluationJob: (jobId, orgId) => existsQuery(`SELECT 1 FROM evaluation_jobs WHERE job_id=$1 AND org_id=$2`, [jobId, orgId]),

  gate: (gateId, orgId) => existsQuery(`SELECT 1 FROM gate_events WHERE gate_id=$1 AND org_id=$2`, [gateId, orgId]),

  kpiScore: (scoreId, orgId) =>
    existsQuery(
      `SELECT 1 FROM kpi_scores s JOIN kpi_definitions d ON d.kpi_id = s.kpi_id WHERE s.score_id=$1 AND d.org_id=$2`,
      [scoreId, orgId]
    ),

  onboardingEmployee: (employeeId, orgId) => existsQuery(`SELECT 1 FROM employees WHERE employee_id=$1 AND org_id=$2`, [employeeId, orgId]),

  onboardingAssignment: (assignmentId, orgId) =>
    existsQuery(
      `SELECT 1 FROM onboarding_assignments oa JOIN employees e ON e.employee_id = oa.employee_id WHERE oa.assignment_id=$1 AND e.org_id=$2`,
      [assignmentId, orgId]
    ),

  persona: (personaId, orgId) => existsQuery(`SELECT 1 FROM personas WHERE persona_id=$1 AND org_id=$2`, [personaId, orgId]),

  rule: (ruleId, orgId) =>
    existsQuery(
      `SELECT 1 FROM rules r
       JOIN rule_pack_versions v ON v.version_id = r.rule_pack_version_id
       JOIN rule_packs p ON p.rule_pack_id = v.rule_pack_id
       WHERE r.rule_id=$1 AND p.org_id=$2`,
      [ruleId, orgId]
    ),

  rulePackVersion: (versionId, orgId) =>
    existsQuery(
      `SELECT 1 FROM rule_pack_versions v JOIN rule_packs p ON p.rule_pack_id = v.rule_pack_id WHERE v.version_id=$1 AND p.org_id=$2`,
      [versionId, orgId]
    ),

  digitalExamSubmission: (submissionId, orgId) =>
    existsQuery(
      `SELECT 1 FROM digital_exam_submissions s JOIN digital_exams e ON e.exam_id = s.exam_id WHERE s.submission_id=$1 AND e.org_id=$2`,
      [submissionId, orgId]
    ),
};
