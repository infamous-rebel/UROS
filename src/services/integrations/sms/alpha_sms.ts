/**
 * Alpha SMS adapter (sms:alpha_sms).
 * Alpha SMS (alpha.sms.net.bd) documented API:
 * GET/POST https://api.sms.net.bd/sendsms with params api_key, msg, to,
 * sender_id. Success JSON: { "error": 0, "msg_id": "<id>" }.
 */

import { Integration, SmsInput, SmsOutput } from "../_base/types";
import { HttpProviderConfig, makeHttpSmsAdapter } from "./shared";

export const alphaSmsAdapter: Integration<HttpProviderConfig, SmsInput, SmsOutput> = makeHttpSmsAdapter("alpha_sms", {
  buildRequest(input: SmsInput, config: HttpProviderConfig) {
    const url = new URL(`${config.baseUrl ?? "https://api.sms.net.bd"}/sendsms`);
    url.searchParams.set("api_key", config.apiKey);
    url.searchParams.set("msg", input.message);
    url.searchParams.set("to", input.to);
    if (input.sender_id) url.searchParams.set("sender_id", input.sender_id);
    return {
      url: url.toString(),
      init: { method: "POST" },
    };
  },
  parseSuccess: (bodyText) => {
    const body = JSON.parse(bodyText) as { error?: number; msg_id?: string | number };
    if (body.error !== 0 || body.msg_id === undefined) {
      throw new Error(`Alpha SMS error response: ${bodyText.slice(0, 200)}`);
    }
    return { provider_message_id: String(body.msg_id) };
  },
});
