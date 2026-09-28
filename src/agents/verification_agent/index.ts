import { Candidate } from "../../models/candidate.model";
import { getCredential } from "../../services/integrations/credential_store";
import { logAudit } from "../../utils/audit_helper";
import { logger } from "../../utils/logger";

export type VerificationSource = "EDUCATION_BOARD" | "CIB" | "POLICE";

export interface VerificationOutcome {
  source: string;
  status: "Verified" | "Failed" | "Manual Review" | "Pending";
  details: Record<string, unknown>;
}

interface SourceCheckResult {
  source: VerificationSource;
  status: "Verified" | "Failed" | "Manual Review" | "Pending";
  details: Record<string, unknown>;
}

/**
 * Each verification source is a distinct external system with its own
 * authority (education board result-verification portal, Bangladesh
 * Bank's CIB system, police clearance system). None of these are AI
 * calls — they are deterministic lookups against an official record;
 * an unavailable connector always resolves to "Manual Review", never a
 * guessed pass.
 *
 * Assumption (stated once): live endpoints for these government/banking
 * systems are not available in this reference environment. Each check
 * function calls out via BYOK credentials to a configurable `base_url`
 * (org-provided), so wiring a real endpoint is a config change, not a
 * code change. Absent a configured credential, the check safely resolves
 * to "Manual Review" rather than fabricating a result — this is a hard
 * requirement, not a fallback of convenience: an unverifiable claim must
 * never silently become a pass.
 */
async function checkEducationBoard(candidate: Candidate): Promise<SourceCheckResult> {
  const cred = await getCredential(candidate.org_id, "education_board");
  return dispatchCheck("EDUCATION_BOARD", candidate, cred?.baseUrl ?? null, cred?.apiKey ?? null, {
    national_id: candidate.national_id,
  });
}

async function checkCib(candidate: Candidate): Promise<SourceCheckResult> {
  const cred = await getCredential(candidate.org_id, "cib");
  return dispatchCheck("CIB", candidate, cred?.baseUrl ?? null, cred?.apiKey ?? null, {
    national_id: candidate.national_id,
  });
}

async function checkPolice(candidate: Candidate): Promise<SourceCheckResult> {
  const cred = await getCredential(candidate.org_id, "police");
  return dispatchCheck("POLICE", candidate, cred?.baseUrl ?? null, cred?.apiKey ?? null, {
    national_id: candidate.national_id,
  });
}

async function dispatchCheck(
  source: VerificationSource,
  candidate: Candidate,
  baseUrl: string | null,
  apiKey: string | null,
  queryParams: Record<string, unknown>
): Promise<SourceCheckResult> {
  if (!baseUrl || !apiKey) {
    return {
      source,
      status: "Manual Review",
      details: { reason: `No ${source} connector configured for this organization; requires manual verification` },
    };
  }

  try {
    const res = await fetch(`${baseUrl}/verify`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(queryParams),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`${source} verification API responded ${res.status}: ${res.statusText}`);

    const body = (await res.json()) as { verified: boolean; details?: Record<string, unknown> };
    return {
      source,
      status: body.verified ? "Verified" : "Failed",
      details: body.details ?? {},
    };
  } catch (err) {
    logger.error("VERIFICATION_CHECK_FAILED", {
      candidate_id: candidate.candidate_id,
      source,
      error: err instanceof Error ? err.message : String(err),
    });
    return { source, status: "Manual Review", details: { error: "Connector call failed; requires manual verification" } };
  }
}

/**
 * Runs all requested verification checks for a candidate. Never auto-fails
 * or auto-passes a candidate to selection — results are written to
 * `verification_results` by the orchestrator and always routed through
 * human sign-off (file 20 §2, Human Review Dashboard).
 */
export async function check(candidate: Candidate, sources: string[]): Promise<VerificationOutcome> {
  const results: SourceCheckResult[] = [];

  for (const source of sources as VerificationSource[]) {
    if (source === "EDUCATION_BOARD") results.push(await checkEducationBoard(candidate));
    else if (source === "CIB") results.push(await checkCib(candidate));
    else if (source === "POLICE") results.push(await checkPolice(candidate));
  }

  const overallStatus: VerificationOutcome["status"] = results.some((r) => r.status === "Failed")
    ? "Failed"
    : results.some((r) => r.status === "Manual Review")
    ? "Manual Review"
    : results.every((r) => r.status === "Verified")
    ? "Verified"
    : "Pending";

  await logAudit({
    entity_type: "VERIFICATION",
    entity_id: candidate.candidate_id,
    agent_or_user: "VerificationAgent",
    action: "VERIFICATION_CHECKED",
    output_value: { sources, overall_status: overallStatus, per_source: results },
  });

  return {
    source: sources.join(","),
    status: overallStatus,
    details: { per_source: results },
  };
}
