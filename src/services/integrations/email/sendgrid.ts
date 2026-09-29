/**
 * SendGrid email adapter (email:sendgrid).
 * Contract: POST https://api.sendgrid.com/v3/mail/send
 * Authorization: Bearer <api key>. Success is 202 with an empty body;
 * the message X-Message-Id header (when echoed by the relay) or a
 * deterministic correlation id is used for communication_log.
 */

import crypto from "crypto";
import { Integration, IntegrationResult, EmailInput, EmailOutput } from "../_base/types";
import { HttpProviderConfig } from "../sms/shared";

/** Maps the uniform EmailInput onto SendGrid's mail.send contract. */
export function toSendGridBody(input: EmailInput) {
  const content: Array<{ type: string; value: string }> = [{ type: "text/plain", value: input.body_text }];
  if (input.body_html) content.push({ type: "text/html", value: input.body_html });
  return {
    personalizations: [{ to: [{ email: input.to }] }],
    ...(input.from ? { from: { email: input.from } } : {}),
    subject: input.subject,
    content,
    ...(input.attachments?.length
      ? {
          attachments: input.attachments.map((a) => ({
            content: a.data.toString("base64"),
            filename: a.filename,
            type: a.content_type,
          })),
        }
      : {}),
  };
}

export const sendgridAdapter: Integration<HttpProviderConfig, EmailInput, EmailOutput> = {
  name: "sendgrid",
  async send(input: EmailInput, config: HttpProviderConfig): Promise<IntegrationResult<EmailOutput>> {
    const url = `${config.baseUrl ?? "https://api.sendgrid.com"}/v3/mail/send`;
    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${config.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(toSendGridBody(input)),
      });
    } catch (err) {
      throw err instanceof Error ? err : new Error(String(err));
    }
    if (!res.ok) {
      return {
        status: "FAILED",
        error_code: `SENDGRID_HTTP_${res.status}`,
        error_message: `SendGrid responded ${res.status}: ${res.statusText}`,
      };
    }
    const headerId = res.headers.get("x-message-id");
    const id = headerId ?? crypto.createHash("sha256").update(`${input.to}:${input.subject}:${Date.now()}`).digest("hex").slice(0, 32);
    return { status: "SENT", provider_id: id, data: { provider_message_id: id } };
  },
  async healthCheck(config: HttpProviderConfig): Promise<boolean> {
    try {
      const res = await fetch(`${config.baseUrl ?? "https://api.sendgrid.com"}/v3/scopes`, {
        headers: { Authorization: `Bearer ${config.apiKey}` },
      });
      return res.ok;
    } catch {
      return false;
    }
  },
};
