/**
 * Airtel Bangladesh SMS adapter (sms:airtel).
 * Airtel enterprise SMS via the org's contracted Airtel gateway
 * (JSON, Bearer auth; Airtel BD shares the Axiata enterprise platform
 * with Robi). No public canonical host — base_url REQUIRED.
 */

import { Integration, SmsInput, SmsOutput } from "../_base/types";
import { HttpProviderConfig, makeHttpSmsAdapter, parseJsonIdField } from "./shared";

export const airtelAdapter: Integration<HttpProviderConfig, SmsInput, SmsOutput> = makeHttpSmsAdapter("airtel", {
  requiresBaseUrl: true,
  buildRequest(input: SmsInput, config: HttpProviderConfig) {
    return {
      url: `${config.baseUrl}/v1/sms`,
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
});
