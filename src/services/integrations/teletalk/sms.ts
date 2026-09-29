/**
 * Teletalk SMS adapter (teletalk:sms).
 * Government-tenant SMS via the Teletalk gateway (JSON, Bearer). Same
 * transport contract as sms:teletalk, registered under the teletalk
 * category for the government-tenant connector naming.
 */

import { Integration, SmsInput, SmsOutput } from "../_base/types";
import { HttpProviderConfig, makeHttpSmsAdapter, parseJsonIdField } from "../sms/shared";

export const teletalkSmsAdapter: Integration<HttpProviderConfig, SmsInput, SmsOutput> = makeHttpSmsAdapter("teletalk_sms", {
  buildRequest(input: SmsInput, config: HttpProviderConfig) {
    return {
      url: `${config.baseUrl ?? "https://sms.teletalk.com.bd"}/api/v1/send`,
      init: {
        method: "POST",
        headers: {
          Authorization: `Bearer ${config.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ to: input.to, message: input.message, sender_id: input.sender_id }),
      },
    };
  },
  parseSuccess: (bodyText) => parseJsonIdField(bodyText),
});
