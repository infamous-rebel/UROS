import { requireCredential } from "../credential_store";
import { logAudit } from "../../../utils/audit_helper";
import { logger } from "../../../utils/logger";

export interface BdjobsResume {
  candidate_id: string;
  full_name: string;
  email?: string;
  phone_primary?: string;
  resume_url: string; // link to CV file for downstream parser_agent
  keywords_matched: string[];
}

export interface BdjobsSearchParams {
  job_posting_id: string;
  keywords: string[];
  min_experience_years?: number;
}

/**
 * Fetches candidates from the bdjobs employer resume bank matching a job
 * posting's keyword filter (file 02 §2, bdjobs.com). Results carry a
 * `resume_url` — the actual CV is fetched and OCR/parsed separately by
 * `parser_agent`, since bdjobs resumes are free-form documents, not
 * structured government-style forms.
 */
export async function searchResumeBank(orgId: string, params: BdjobsSearchParams): Promise<BdjobsResume[]> {
  const { apiKey, baseUrl } = await requireCredential(orgId, "bdjobs");
  const url = new URL(`${baseUrl ?? "https://api.bdjobs.com"}/v1/resume-bank/search`);
  url.searchParams.set("job_posting_id", params.job_posting_id);
  url.searchParams.set("keywords", params.keywords.join(","));
  if (params.min_experience_years !== undefined) {
    url.searchParams.set("min_experience_years", String(params.min_experience_years));
  }

  let results: BdjobsResume[] = [];
  try {
    const res = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
    });
    if (!res.ok) throw new Error(`bdjobs API responded ${res.status}: ${res.statusText}`);
    const body = (await res.json()) as { candidates: BdjobsResume[] };
    results = body.candidates ?? [];
  } catch (err) {
    logger.error("BDJOBS_SEARCH_FAILED", {
      job_posting_id: params.job_posting_id,
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }

  await logAudit({
    entity_type: "INTEGRATION",
    entity_id: params.job_posting_id,
    agent_or_user: "BdjobsConnector",
    action: "RESUME_BANK_SEARCHED",
    output_value: { connector: "bdjobs", keywords: params.keywords, count: results.length },
  });

  return results;
}

/**
 * Deterministic keyword-relevance filter applied client-side as a second
 * pass (in case the remote API's ranking is opaque). Simple case-insensitive
 * substring match against name/keywords_matched — no ML scoring.
 */
export function filterByKeywords(resumes: BdjobsResume[], requiredKeywords: string[]): BdjobsResume[] {
  const required = requiredKeywords.map((k) => k.toLowerCase());
  return resumes.filter((r) => {
    const haystack = r.keywords_matched.map((k) => k.toLowerCase());
    return required.every((k) => haystack.includes(k));
  });
}
