/**
 * Teletalk CV Bank adapter (teletalk:cv_bank).
 * Fetches structured applications from the Teletalk portal API for a
 * circular. Teletalk applications are structured form data (no OCR
 * needed downstream). base_url REQUIRED (government contract endpoint).
 */

import { Integration, IntegrationResult } from "../_base/types";
import { HttpProviderConfig, MissingBaseUrlError } from "../sms/shared";
import type { RawTeletalkApplication } from "../teletalk";

export interface CvBankInput {
  circular_id: string;
}

export interface CvBankOutput {
  applications: RawTeletalkApplication[];
}

export const teletalkCvBankAdapter: Integration<HttpProviderConfig, CvBankInput, CvBankOutput> = {
  name: "cv_bank",
  async send(input: CvBankInput, config: HttpProviderConfig): Promise<IntegrationResult<CvBankOutput>> {
    if (!config.baseUrl) {
      throw new MissingBaseUrlError("cv_bank", config.orgId);
    }
    let res: Response;
    try {
      res = await fetch(`${config.baseUrl}/v1/circulars/${encodeURIComponent(input.circular_id)}/applications`, {
        headers: { Authorization: `Bearer ${config.apiKey}`, Accept: "application/json" },
      });
    } catch (err) {
      throw err instanceof Error ? err : new Error(String(err));
    }
    if (!res.ok) {
      return {
        status: "FAILED",
        error_code: `TELETALK_HTTP_${res.status}`,
        error_message: `Teletalk CV Bank responded ${res.status}: ${res.statusText}`,
      };
    }
    const body = (await res.json()) as { applications?: RawTeletalkApplication[] };
    return { status: "DELIVERED", data: { applications: body.applications ?? [] } };
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
