/**
 * Bulk SMS BD adapter (sms:bulk_sms_bd).
 * bulksmsbd.com gateway via the org's contracted endpoint (JSON,
 * X-Api-Key header). No public canonical host — base_url REQUIRED.
 */

import { Integration, SmsInput, SmsOutput } from "../_base/types";
import { HttpProviderConfig, makeHttpSmsAdapter, parseJsonIdField } from "./shared";

export const bulkSmsBdAdapter: Integration<HttpProviderConfig, SmsInput, SmsOutput> = makeHttpSmsAdapter(
  "bulk_sms_bd",
  {
    requiresBaseUrl: true,
    buildRequest(input: SmsInput, config: HttpProviderConfig) {
      return {
        url: `${config.baseUrl}/api/send`,
        init: {
          method: "POST",
          headers: {
            "X-Api-Key": config.apiKey,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ to: input.to, message: input.message, sender_id: input.sender_id }),
        },
      };
    },
    parseSuccess: (bodyText) => parseJsonIdField(bodyText),
  }
);
