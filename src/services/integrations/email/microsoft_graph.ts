/**
 * Microsoft Graph email adapter (email:microsoft_graph).
 * Sends via Graph /me/sendMail using the org's BYOK OAuth token.
 * Contract: POST https://graph.microsoft.com/v1.0/me/sendMail
 * Authorization: Bearer <token>. Returns 202 Accepted (no message id in
 * the response body — a provider_message_id is synthesised from the
 * request for communication_log correlation).
 */

import crypto from "crypto";
import { Integration, IntegrationResult, EmailInput, EmailOutput } from "../_base/types";
import { HttpProviderConfig } from "../sms/shared";

/** Maps the uniform EmailInput onto Graph's message resource. */
export function toGraphMessage(input: EmailInput) {
  return {
    message: {
      subject: input.subject,
      body: { contentType: input.body_html ? "HTML" : "Text", content: input.body_html ?? input.body_text },
      ...(input.from ? { from: { emailAddress: { address: input.from } } } : {}),
      toRecipients: [{ emailAddress: { address: input.to } }],
      ...(input.attachments?.length
        ? {
            attachments: input.attachments.map((a) => ({
              "@odata.type": "#microsoft.graph.fileAttachment",
              name: a.filename,
              contentType: a.content_type,
              contentBytes: a.data.toString("base64"),
            })),
          }
        : {}),
    },
    saveToSentItems: true,
  };
}

export const microsoftGraphAdapter: Integration<HttpProviderConfig, EmailInput, EmailOutput> = {
  name: "microsoft_graph",
  async send(input: EmailInput, config: HttpProviderConfig): Promise<IntegrationResult<EmailOutput>> {
    const url = `${config.baseUrl ?? "https://graph.microsoft.com"}/v1.0/me/sendMail`;
    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${config.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(toGraphMessage(input)),
      });
    } catch (err) {
      throw err instanceof Error ? err : new Error(String(err));
    }
    if (!res.ok) {
      return {
        status: "FAILED",
        error_code: `GRAPH_HTTP_${res.status}`,
        error_message: `Microsoft Graph responded ${res.status}: ${res.statusText}`,
      };
    }
    // Graph sendMail returns 202 with an empty body; synthesise a
    // correlation id deterministic to this request.
    const syntheticId = crypto
      .createHash("sha256")
      .update(`${input.to}:${input.subject}:${Date.now()}`)
      .digest("hex")
      .slice(0, 32);
    return { status: "SENT", provider_id: syntheticId, data: { provider_message_id: syntheticId } };
  },
  async healthCheck(config: HttpProviderConfig): Promise<boolean> {
    try {
      const res = await fetch(`${config.baseUrl ?? "https://graph.microsoft.com"}/v1.0/me`, {
        headers: { Authorization: `Bearer ${config.apiKey}` },
      });
      return res.ok;
    } catch {
      return false;
    }
  },
};
