/**
 * VOIP adapter (voip:voip).
 * Places automated interview-reminder calls through the org's contracted
 * VOIP gateway (JSON, Bearer). No public canonical host — base_url
 * REQUIRED (each VOIP provider fronts its own endpoint).
 */

import { Integration, IntegrationResult } from "../_base/types";
import { HttpProviderConfig, MissingBaseUrlError } from "../sms/shared";

export interface VoipInput {
  to: string;
  /** Pre-recorded prompt id or inline text the gateway TTSes. */
  message: string;
  /** Caller id presented to the recipient (org's contracted number). */
  caller_id?: string;
}

export interface VoipOutput {
  call_id: string;
}

export const voipAdapter: Integration<HttpProviderConfig, VoipInput, VoipOutput> = {
  name: "voip",
  async send(input: VoipInput, config: HttpProviderConfig): Promise<IntegrationResult<VoipOutput>> {
    if (!config.baseUrl) {
      throw new MissingBaseUrlError("voip", config.orgId);
    }
    let res: Response;
    try {
      res = await fetch(`${config.baseUrl}/v1/calls`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${config.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ to: input.to, message: input.message, caller_id: input.caller_id }),
      });
    } catch (err) {
      throw err instanceof Error ? err : new Error(String(err));
    }
    if (!res.ok) {
      return {
        status: "FAILED",
        error_code: `VOIP_HTTP_${res.status}`,
        error_message: `VOIP gateway responded ${res.status}: ${res.statusText}`,
      };
    }
    const body = (await res.json()) as { call_id?: string; id?: string };
    const id = body.call_id ?? body.id;
    if (!id) {
      return { status: "FAILED", error_code: "MALFORMED_PROVIDER_RESPONSE", error_message: "VOIP response missing call id." };
    }
    return { status: "SENT", provider_id: id, data: { call_id: id } };
  },
  async healthCheck(config: HttpProviderConfig): Promise<boolean> {
    if (!config.baseUrl) return false;
    try {
      const res = await fetch(`${config.baseUrl}/v1/health`, {
        headers: { Authorization: `Bearer ${config.apiKey}` },
      });
      return res.status < 500;
    } catch {
      return false;
    }
  },
};
