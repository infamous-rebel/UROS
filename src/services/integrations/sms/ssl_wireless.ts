/**
 * SSL Wireless SMS adapter (sms:ssl_wireless).
 * SSL Wireless is Bangladesh's largest SMS aggregator. Documented API v3:
 * POST {base}/api/v3/sendSMS with form params token, msisdn, message,
 * csms_id (client-side unique id for de-duplication). Success response is
 * plain text "SMS SUBMITTED" (with optional message id suffix).
 */

import crypto from "crypto";
import { Integration, SmsInput, SmsOutput } from "../_base/types";
import { HttpProviderConfig, makeHttpSmsAdapter } from "./shared";

export const sslWirelessAdapter: Integration<HttpProviderConfig, SmsInput, SmsOutput> = makeHttpSmsAdapter(
  "ssl_wireless",
  {
    requiresBaseUrl: true,
    buildRequest(input: SmsInput, config: HttpProviderConfig) {
      const params = new URLSearchParams({
        token: config.apiKey,
        msisdn: input.to,
        message: input.message,
        // Deterministic client id: hash of recipient + content, so a retried
        // send of the same message carries the same csms_id and the gateway
        // can de-duplicate.
        csms_id: crypto.createHash("sha256").update(`${input.to}:${input.message}`).digest("hex").slice(0, 40),
      });
      return {
        url: `${config.baseUrl}/api/v3/sendSMS`,
        init: {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: params.toString(),
        },
      };
    },
    parseSuccess: (bodyText) => {
      // Documented success: "SMS SUBMITTED" or "SMS SUBMITTED:<id>".
      const text = bodyText.trim();
      if (!/^SMS SUBMITTED/i.test(text)) {
        throw new Error(`Unexpected SSL Wireless response: ${text.slice(0, 120)}`);
      }
      const id = text.includes(":") ? text.split(":")[1].trim() : text;
      return { provider_message_id: id };
    },
  }
);
