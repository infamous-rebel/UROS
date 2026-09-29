/**
 * LinkedIn adapter (linkedin:linkedin).
 * Fetches a candidate profile for corporate-role import. Uses the org's
 * stored "access_token" BYOK credential label. base_url overrides the
 * canonical api.linkedin.com host so deployments fronting their own relay
 * (and contract tests) can target it.
 */

import { Integration, IntegrationResult } from "../_base/types";
import { HttpProviderConfig } from "../sms/shared";
import type { LinkedInProfile } from "../linkedin";

export type LinkedInFetchInput = { profile_id: string };
export type LinkedInOutput = LinkedInProfile;

export const linkedinAdapter: Integration<HttpProviderConfig, LinkedInFetchInput, LinkedInOutput> = {
  name: "linkedin",
  async send(input: LinkedInFetchInput, config: HttpProviderConfig): Promise<IntegrationResult<LinkedInOutput>> {
    let res: Response;
    try {
      res = await fetch(`${config.baseUrl ?? "https://api.linkedin.com"}/v2/people/${encodeURIComponent(input.profile_id)}`, {
        headers: { Authorization: `Bearer ${config.apiKey}` },
      });
    } catch (err) {
      throw err instanceof Error ? err : new Error(String(err));
    }
    if (!res.ok) {
      return {
        status: "FAILED",
        error_code: `LINKEDIN_HTTP_${res.status}`,
        error_message: `LinkedIn profile fetch responded ${res.status}: ${res.statusText}`,
      };
    }
    const profile = (await res.json()) as LinkedInProfile;
    return { status: "DELIVERED", data: profile };
  },
  async healthCheck(config: HttpProviderConfig): Promise<boolean> {
    try {
      const res = await fetch(`${config.baseUrl ?? "https://api.linkedin.com"}/v2/me`, {
        headers: { Authorization: `Bearer ${config.apiKey}` },
      });
      return res.ok;
    } catch {
      return false;
    }
  },
};
