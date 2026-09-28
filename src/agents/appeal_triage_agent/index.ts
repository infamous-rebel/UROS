import { db } from "../../database/client";
import { logAudit } from "../../utils/audit_helper";

export type AppealCategory = "Data Error" | "Rule Misapplication" | "Document Update" | "Quota Dispute";

const KEYWORD_RULES: Array<{ pattern: RegExp; category: AppealCategory }> = [
  { pattern: /wrong|incorrect|typo|misread|misspell/i, category: "Data Error" },
  { pattern: /rule|threshold|cutoff|criteria/i, category: "Rule Misapplication" },
  { pattern: /certificate|document|scan|upload|corrected/i, category: "Document Update" },
  { pattern: /quota|freedom fighter|indigenous|disability/i, category: "Quota Dispute" },
];

/** Deterministic keyword classification — a suggestion only; the applicant's own submitted category always wins if provided. */
export function classifyAppealText(reasonText: string): AppealCategory {
  for (const rule of KEYWORD_RULES) {
    if (rule.pattern.test(reasonText)) return rule.category;
  }
  return "Data Error";
}

/** Priority: Quota/Rule issues affecting eligibility outrank simple data-entry fixes. */
export function computePriority(category: AppealCategory): "HIGH" | "MEDIUM" | "LOW" {
  if (category === "Quota Dispute" || category === "Rule Misapplication") return "HIGH";
  if (category === "Document Update") return "MEDIUM";
  return "LOW";
}

/** Assigns the appeal to the SENIOR_RECRUITER with the fewest open appeals in this org (deterministic load-balance, not ML). */
export async function assignReviewer(orgId: string): Promise<string | null> {
  const res = await db.query<{ user_id: string }>(
    `SELECT u.user_id
     FROM users u
     LEFT JOIN appeals a ON a.assigned_to = u.user_id AND a.status IN ('SUBMITTED','TRIAGED','UNDER_REVIEW')
     WHERE u.org_id=$1 AND u.role='SENIOR_RECRUITER' AND u.active=true
     GROUP BY u.user_id
     ORDER BY COUNT(a.appeal_id) ASC, u.user_id ASC
     LIMIT 1`,
    [orgId]
  );
  return res.rows[0]?.user_id ?? null;
}

/** Runs triage on a newly submitted appeal: confirms/derives category, sets priority, assigns a reviewer. Never resolves the appeal itself. */
export async function triageAppeal(appealId: string, orgId: string): Promise<void> {
  const appealRes = await db.query(`SELECT * FROM appeals WHERE appeal_id=$1 AND org_id=$2`, [appealId, orgId]);
  if (appealRes.rowCount === 0) return;
  const appeal = appealRes.rows[0];

  const suggestedCategory = classifyAppealText(appeal.reason_text ?? "");
  const priority = computePriority(appeal.category ?? suggestedCategory);
  const reviewer = await assignReviewer(orgId);

  await db.query(
    `UPDATE appeals SET status='TRIAGED', assigned_to=COALESCE($1, assigned_to) WHERE appeal_id=$2 AND org_id=$3`,
    [reviewer, appealId, orgId]
  );

  await logAudit({
    org_id: orgId,
    entity_type: "APPEAL",
    entity_id: appealId,
    agent_or_user: "AppealTriageAgent",
    action: "APPEAL_TRIAGED",
    output_value: { suggested_category: suggestedCategory, priority, assigned_to: reviewer },
  });
}
