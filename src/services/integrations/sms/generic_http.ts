/**
 * Generic HTTP SMS adapter (sms:generic_http).
 * The escape hatch for any gateway whose contract matches the common
 * "POST {base}/send with JSON {to, message, sender_id?}" shape (a large
 * share of BD regional gateways front exactly this contract, or an
 * org-owned relay normalises to it). Auth: Bearer when the org stores a
 * non-empty key. base_url REQUIRED.
 */

import { Integration, SmsInput, SmsOutput } from "../_base/types";
import { HttpProviderConfig, makeHttpSmsAdapter, parseJsonIdField } from "./shared";

export const genericHttpAdapter: Integration<HttpProviderConfig, SmsInput, SmsOutput> = makeHttpSmsAdapter(
  "generic_http",
  {
    requiresBaseUrl: true,
    buildRequest(input: SmsInput, config: HttpProviderConfig) {
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (config.apiKey) headers["Authorization"] = `Bearer ${config.apiKey}`;
      return {
        url: `${config.baseUrl}/send`,
        init: {
          method: "POST",
          headers,
          body: JSON.stringify({ to: input.to, message: input.message, sender_id: input.sender_id }),
        },
      };
    },
    parseSuccess: (bodyText) => parseJsonIdField(bodyText),
  }
);
