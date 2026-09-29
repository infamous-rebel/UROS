/**
 * Banglalink SMS adapter (sms:banglalink).
 * Banglalink enterprise SMS is delivered through the org's contracted
 * Banglalink gateway (JSON, Bearer auth). No public canonical host —
 * base_url from BYOK is REQUIRED.
 */

import { Integration, SmsInput, SmsOutput } from "../_base/types";
import { HttpProviderConfig, makeHttpSmsAdapter, parseJsonIdField } from "./shared";

export const banglalinkAdapter: Integration<HttpProviderConfig, SmsInput, SmsOutput> = makeHttpSmsAdapter(
  "banglalink",
  {
    requiresBaseUrl: true,
    buildRequest(input: SmsInput, config: HttpProviderConfig) {
      return {
        url: `${config.baseUrl}/v1/messages`,
        init: {
          method: "POST",
          headers: {
            Authorization: `Bearer ${config.apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ msisdn: input.to, message: input.message }),
        },
      };
    },
    parseSuccess: (bodyText) => parseJsonIdField(bodyText),
  }
);
