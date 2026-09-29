/**
 * bdjobs Path A — Session Scraper adapter (bdjobs:path_a_session_scraper).
 * Searches the bdjobs employer resume bank through the org's contracted
 * employer-portal endpoint (session-scoped). base_url REQUIRED.
 * The scraped surface changes without notice; results always pass through
 * the deterministic keyword filter downstream — no ML scoring.
 */

import { Integration, IntegrationResult } from "../_base/types";
import { HttpProviderConfig, MissingBaseUrlError } from "../sms/shared";
import type { BdjobsResume, BdjobsSearchParams } from "../bdjobs";

export type BdjobsScraperOutput = BdjobsResume[];

export const bdjobsSessionScraperAdapter: Integration<HttpProviderConfig, BdjobsSearchParams, BdjobsScraperOutput> = {
  name: "path_a_session_scraper",
  async send(input: BdjobsSearchParams, config: HttpProviderConfig): Promise<IntegrationResult<BdjobsScraperOutput>> {
    if (!config.baseUrl) {
      throw new MissingBaseUrlError("path_a_session_scraper", config.orgId);
    }
    const url = new URL(`${config.baseUrl}/v1/resume-bank/search`);
    url.searchParams.set("job_posting_id", input.job_posting_id);
    url.searchParams.set("keywords", input.keywords.join(","));
    if (input.min_experience_years !== undefined) {
      url.searchParams.set("min_experience_years", String(input.min_experience_years));
    }

    let res: Response;
    try {
      res = await fetch(url.toString(), {
        headers: { Authorization: `Bearer ${config.apiKey}`, Accept: "application/json" },
      });
    } catch (err) {
      throw err instanceof Error ? err : new Error(String(err));
    }
    if (!res.ok) {
      return {
        status: "FAILED",
        error_code: `BDJOBS_HTTP_${res.status}`,
        error_message: `bdjobs resume bank responded ${res.status}: ${res.statusText}`,
      };
    }
    const body = (await res.json()) as { candidates?: BdjobsResume[] };
    return { status: "DELIVERED", data: body.candidates ?? [] };
  },
  async healthCheck(config: HttpProviderConfig): Promise<boolean> {
    if (!config.baseUrl) return false;
    try {
      const res = await fetch(`${config.baseUrl}/v1/session/ping`, {
        headers: { Authorization: `Bearer ${config.apiKey}` },
      });
      return res.status < 500;
    } catch {
      return false;
    }
  },
};
