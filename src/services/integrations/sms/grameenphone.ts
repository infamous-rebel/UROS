/**
 * Grameenphone SMS adapter (sms:grameenphone).
 * GP enterprise SMS is delivered through the org's contracted GP gateway
 * (JSON, Bearer auth). There is no public canonical host — base_url from
 * BYOK is REQUIRED and its absence is a malformed credential.
 */

import { Integration, SmsInput, SmsOutput } from "../_base/types";
import { HttpProviderConfig, makeHttpSmsAdapter, parseJsonIdField } from "./shared";

export const grameenphoneAdapter: Integration<HttpProviderConfig, SmsInput, SmsOutput> = makeHttpSmsAdapter(
  "grameenphone",
  {
    requiresBaseUrl: true,
    buildRequest(input: SmsInput, config: HttpProviderConfig) {
      return {
        url: `${config.baseUrl}/sms/send`,
        init: {
          method: "POST",
          headers: {
            Authorization: `Bearer ${config.apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ msisdn: input.to, text: input.message, sender: input.sender_id }),
        },
      };
    },
    parseSuccess: (bodyText) => parseJsonIdField(bodyText),
  }
);
