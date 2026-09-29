/**
 * bdjobs Path B — CSV Import adapter (bdjobs:path_b_csv_import).
 * Parses a bdjobs resume-bank CSV export into structured candidate
 * records. Pure transformation — no network, no credentials consumed.
 * healthCheck is trivially true (stateless import path).
 */

import { Integration, IntegrationResult } from "../_base/types";
import { HttpProviderConfig } from "../sms/shared";
import type { BdjobsResume } from "../bdjobs";

export interface BdjobsCsvInput {
  csv_text: string;
}

export type BdjobsCsvOutput = BdjobsResume[];

export function parseBdjobsCsv(csvText: string): BdjobsResume[] {
  const lines = csvText.trim().split(/\r?\n/);
  if (lines.length === 0) return [];
  const [headerLine, ...rows] = lines;
  const headers = headerLine.split(",").map((h) => h.trim());

  return rows
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      const cells = line.split(",").map((c) => c.trim());
      const record: Record<string, string> = {};
      headers.forEach((h, i) => (record[h] = cells[i] ?? ""));
      return {
        candidate_id: record["candidate_id"] ?? "",
        full_name: record["full_name"] ?? "",
        email: record["email"] || undefined,
        phone_primary: record["phone_primary"] || undefined,
        resume_url: record["resume_url"] ?? "",
        keywords_matched: (record["keywords"] ?? "")
          .split("|")
          .map((k) => k.trim())
          .filter(Boolean),
      };
    });
}

export const bdjobsCsvImportAdapter: Integration<HttpProviderConfig, BdjobsCsvInput, BdjobsCsvOutput> = {
  name: "path_b_csv_import",
  async send(input: BdjobsCsvInput, _config: HttpProviderConfig): Promise<IntegrationResult<BdjobsCsvOutput>> {
    void _config;
    const rows = parseBdjobsCsv(input.csv_text);
    const invalid = rows.filter((r) => !r.candidate_id || !r.full_name).length;
    if (rows.length === 0) {
      return { status: "FAILED", error_code: "CSV_EMPTY", error_message: "CSV import produced no rows — check the header line." };
    }
    if (invalid > 0) {
      return {
        status: "FAILED",
        error_code: "CSV_INVALID_ROWS",
        error_message: `${invalid} of ${rows.length} rows are missing candidate_id or full_name.`,
      };
    }
    return { status: "DELIVERED", data: rows };
  },
  async healthCheck(): Promise<boolean> {
    // Stateless import path — nothing to probe.
    return true;
  },
};
