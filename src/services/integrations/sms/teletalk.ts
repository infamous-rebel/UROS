/**
 * Teletalk SMS adapter (sms:teletalk).
 * JSON Bearer contract against the org's contracted Teletalk gateway
 * endpoint (base_url from BYOK). Mirrors the legacy sms_provider JSON
 * shape so orgs migrating from the legacy connector keep their gateway.
 */

import { Integration, SmsInput, SmsOutput } from "../_base/types";
import { HttpProviderConfig, makeHttpSmsAdapter, parseJsonIdField } from "./shared";

const adapter = makeHttpSmsAdapter("teletalk", {
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

export const teletalkAdapter: Integration<HttpProviderConfig, SmsInput, SmsOutput> = adapter;
