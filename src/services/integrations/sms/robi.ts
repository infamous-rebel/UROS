/**
 * Robi SMS adapter (sms:robi).
 * Robi enterprise SMS via the org's contracted Robi/Axiata gateway
 * (JSON, Bearer auth). No public canonical host — base_url REQUIRED.
 */

import { Integration, SmsInput, SmsOutput } from "../_base/types";
import { HttpProviderConfig, makeHttpSmsAdapter, parseJsonIdField } from "./shared";

export const robiAdapter: Integration<HttpProviderConfig, SmsInput, SmsOutput> = makeHttpSmsAdapter("robi", {
  requiresBaseUrl: true,
  buildRequest(input: SmsInput, config: HttpProviderConfig) {
    return {
      url: `${config.baseUrl}/api/sms/send`,
      init: {
        method: "POST",
        headers: {
          Authorization: `Bearer ${config.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ msisdn: input.to, message: input.message, senderId: input.sender_id }),
      },
    };
  },
  parseSuccess: (bodyText) => parseJsonIdField(bodyText),
});
