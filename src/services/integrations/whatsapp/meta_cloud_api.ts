/**
 * WhatsApp Meta Cloud API adapter (whatsapp:meta_cloud_api).
 * Sends pre-approved template messages via Meta's Cloud API.
 * Contract: POST {graph-host}/{phone_number_id}/messages with Bearer token.
 * Credential format (BYOK):
 * - apiKey: permanent access token
 * - baseUrl: https://graph.facebook.com/<version> (canonical default)
 * The phone number id rides on the input (per send), since an org may
 * serve multiple WABA numbers.
 */

import { Integration, IntegrationResult, WhatsAppInput, WhatsAppOutput } from "../_base/types";
import { HttpProviderConfig } from "../sms/shared";

export interface MetaWhatsAppSendInput extends WhatsAppInput {
  /** Meta phone number id (from the org's WABA configuration). */
  phone_number_id: string;
}

export const metaCloudApiAdapter: Integration<HttpProviderConfig, MetaWhatsAppSendInput, WhatsAppOutput> = {
  name: "meta_cloud_api",
  async send(input: MetaWhatsAppSendInput, config: HttpProviderConfig): Promise<IntegrationResult<WhatsAppOutput>> {
    if (!input.phone_number_id) {
      return {
        status: "FAILED",
        error_code: "MISSING_PHONE_NUMBER_ID",
        error_message: "Meta Cloud API send requires phone_number_id (the WABA phone number delivering the message).",
      };
    }
    const url = `${config.baseUrl ?? "https://graph.facebook.com/v19.0"}/${input.phone_number_id}/messages`;
    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${config.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          messaging_product: "whatsapp",
          to: input.to,
          type: "template",
          template: {
            name: input.template_name,
            language: { code: input.language ?? "en" },
            components: [
              {
                type: "body",
                parameters: Object.entries(input.template_params).map(([key, value]) => ({
                  type: "text",
                  text: value,
                  parameter_name: key,
                })),
              },
            ],
          },
        }),
      });
    } catch (err) {
      throw err instanceof Error ? err : new Error(String(err));
    }
    if (!res.ok) {
      return {
        status: "FAILED",
        error_code: `WHATSAPP_HTTP_${res.status}`,
        error_message: `WhatsApp Cloud API responded ${res.status}: ${res.statusText}`,
      };
    }
    const body = (await res.json()) as { messages?: Array<{ id: string }> };
    const id = body.messages?.[0]?.id ?? "";
    return { status: "SENT", provider_id: id, data: { provider_message_id: id } };
  },
  async healthCheck(config: HttpProviderConfig): Promise<boolean> {
    // Token validity probe: GET /me on the graph host.
    try {
      const res = await fetch(`${config.baseUrl ?? "https://graph.facebook.com/v19.0"}/me`, {
        headers: { Authorization: `Bearer ${config.apiKey}` },
      });
      return res.ok;
    } catch {
      return false;
    }
  },
};
