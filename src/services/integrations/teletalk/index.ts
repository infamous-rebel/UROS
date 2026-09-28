import { requireCredential } from "../credential_store";
import { logAudit } from "../../../utils/audit_helper";
import { logger } from "../../../utils/logger";

export interface RawTeletalkApplication {
  candidate_id: string;
  full_name: string;
  father_name?: string;
  mother_name?: string;
  date_of_birth?: string;
  phone_primary?: string;
  email?: string;
  national_id?: string;
  academic?: Array<{
    level: string;
    institution?: string;
    board_or_university?: string;
    passing_year?: number;
    division_class?: string;
    cgpa?: number;
  }>;
  quota_type?: string;
}

export interface TeletalkFetchResult {
  circular_id: string;
  applications: RawTeletalkApplication[];
  fetched_at: string;
}

/**
 * Fetches a batch of structured applications from the Teletalk portal API
 * for a given circular. Teletalk applications are always structured form
 * data (no free-form CV) — see file 01 §3.1 — so data_confidence is High
 * and no OCR is required downstream.
 *
 * Uses the org's BYOK credential (bearer token) resolved via credential_store.
 */
export async function fetchApplicationsFromApi(
  orgId: string,
  circularId: string
): Promise<TeletalkFetchResult> {
  const { apiKey, baseUrl } = await requireCredential(orgId, "teletalk");
  const url = `${baseUrl ?? "https://api.teletalk.example.bd"}/v1/circulars/${circularId}/applications`;

  let applications: RawTeletalkApplication[] = [];
  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
    });
    if (!res.ok) {
      throw new Error(`Teletalk API responded ${res.status}: ${res.statusText}`);
    }
    const body = (await res.json()) as { applications: RawTeletalkApplication[] };
    applications = body.applications ?? [];
  } catch (err) {
    logger.error("TELETALK_FETCH_FAILED", {
      circularId,
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }

  await logAudit({
    entity_type: "INTEGRATION",
    entity_id: circularId,
    agent_or_user: "TeletalkConnector",
    action: "APPLICATIONS_FETCHED",
    output_value: { connector: "teletalk", circular_id: circularId, count: applications.length },
  });

  return { circular_id: circularId, applications, fetched_at: new Date().toISOString() };
}

/**
 * Parses a Teletalk CSV export (offline import fallback per file 02 §2).
 * Expected columns: candidate_id,full_name,phone_primary,email,national_id,
 * hsc_division,hsc_cgpa,ssc_division,ssc_cgpa
 */
export function parseApplicationsFromCsv(csvText: string, circularId: string): TeletalkFetchResult {
  const lines = csvText.trim().split(/\r?\n/);
  const [headerLine, ...rows] = lines;
  const headers = headerLine.split(",").map((h) => h.trim());

  const applications: RawTeletalkApplication[] = rows
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      const cells = line.split(",").map((c) => c.trim());
      const record: Record<string, string> = {};
      headers.forEach((h, i) => (record[h] = cells[i] ?? ""));

      return {
        candidate_id: record["candidate_id"],
        full_name: record["full_name"],
        phone_primary: record["phone_primary"] || undefined,
        email: record["email"] || undefined,
        national_id: record["national_id"] || undefined,
        academic: [
          record["hsc_division"]
            ? {
                level: "HSC",
                division_class: record["hsc_division"],
                cgpa: record["hsc_cgpa"] ? Number(record["hsc_cgpa"]) : undefined,
              }
            : undefined,
          record["ssc_division"]
            ? {
                level: "SSC",
                division_class: record["ssc_division"],
                cgpa: record["ssc_cgpa"] ? Number(record["ssc_cgpa"]) : undefined,
              }
            : undefined,
        ].filter(Boolean) as RawTeletalkApplication["academic"],
      };
    });

  return { circular_id: circularId, applications, fetched_at: new Date().toISOString() };
}
