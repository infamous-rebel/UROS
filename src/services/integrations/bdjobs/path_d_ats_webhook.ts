/**
 * bdjobs Path D — ATS Webhook adapter (bdjobs:path_d_ats_webhook).
 * Pushes candidate payloads to the org's ATS webhook endpoint so an
 * external ATS stays in sync with UROS shortlisting. base_url REQUIRED.
 */

import { Integration, IntegrationResult } from "../_base/types";
import { HttpProviderConfig, MissingBaseUrlError } from "../sms/shared";

export interface BdjobsWebhookInput {
  /** Deduplication/event id for the receiving ATS. */
  event_id: string;
  event_type: "candidate_shortlisted" | "candidate_selected" | "candidate_rejected";
  candidate: {
    candidate_id: string;
    full_name: string;
    score?: number;
    status?: string;
  };
}

export interface BdjobsWebhookOutput {
  accepted: boolean;
}

export const bdjobsAtsWebhookAdapter: Integration<HttpProviderConfig, BdjobsWebhookInput, BdjobsWebhookOutput> = {
  name: "path_d_ats_webhook",
  async send(input: BdjobsWebhookInput, config: HttpProviderConfig): Promise<IntegrationResult<BdjobsWebhookOutput>> {
    if (!config.baseUrl) {
      throw new MissingBaseUrlError("path_d_ats_webhook", config.orgId);
    }
    let res: Response;
    try {
      res = await fetch(`${config.baseUrl}/candidates`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${config.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(input),
      });
    } catch (err) {
      throw err instanceof Error ? err : new Error(String(err));
    }
    if (!res.ok) {
      return {
        status: "FAILED",
        error_code: `ATS_HTTP_${res.status}`,
        error_message: `ATS webhook responded ${res.status}: ${res.statusText}`,
      };
    }
    return { status: "SENT", data: { accepted: true } };
  },
  async healthCheck(config: HttpProviderConfig): Promise<boolean> {
    if (!config.baseUrl) return false;
    try {
      const res = await fetch(`${config.baseUrl}/health`, {
        headers: { Authorization: `Bearer ${config.apiKey}` },
      });
      return res.status < 500;
    } catch {
      return false;
    }
  },
};
