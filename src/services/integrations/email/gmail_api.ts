/**
 * Gmail API email adapter (email:gmail_api).
 * Sends via the Gmail REST API using the org's BYOK OAuth token.
 * Contract: POST https://gmail.googleapis.com/gmail/v1/users/me/messages/send
 * Authorization: Bearer <token>. Message delivered as base64url raw MIME.
 */

import { Integration, IntegrationResult, EmailInput, EmailOutput } from "../_base/types";
import { HttpProviderConfig } from "../sms/shared";

/** Builds a minimal RFC 5322 MIME message from the uniform input. */
export function buildMimeText(input: EmailInput): string {
  const headers = [
    `To: ${input.to}`,
    ...(input.from ? [`From: ${input.from}`] : []),
    `Subject: ${input.subject}`,
    "MIME-Version: 1.0",
  ];
  if (input.body_html) {
    const boundary = `uros-${Date.now()}-alt`;
    return [
      ...headers,
      `Content-Type: multipart/alternative; boundary="${boundary}"`,
      "",
      `--${boundary}`,
      "Content-Type: text/plain; charset=UTF-8",
      "",
      input.body_text,
      `--${boundary}`,
      "Content-Type: text/html; charset=UTF-8",
      "",
      input.body_html,
      `--${boundary}--`,
      "",
    ].join("\r\n");
  }
  return [...headers, "Content-Type: text/plain; charset=UTF-8", "", input.body_text, ""].join("\r\n");
}

/** RFC 4648 §5 base64url (Gmail's raw format). */
export function toBase64Url(text: string): string {
  return Buffer.from(text, "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export const gmailApiAdapter: Integration<HttpProviderConfig, EmailInput, EmailOutput> = {
  name: "gmail_api",
  async send(input: EmailInput, config: HttpProviderConfig): Promise<IntegrationResult<EmailOutput>> {
    const url = `${config.baseUrl ?? "https://gmail.googleapis.com"}/gmail/v1/users/me/messages/send`;
    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${config.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ raw: toBase64Url(buildMimeText(input)) }),
      });
    } catch (err) {
      throw err instanceof Error ? err : new Error(String(err));
    }
    if (!res.ok) {
      return {
        status: "FAILED",
        error_code: `GMAIL_HTTP_${res.status}`,
        error_message: `Gmail API responded ${res.status}: ${res.statusText}`,
      };
    }
    const body = (await res.json()) as { id?: string };
    return { status: "SENT", provider_id: body.id, data: { provider_message_id: body.id ?? "" } };
  },
  async healthCheck(config: HttpProviderConfig): Promise<boolean> {
    try {
      const res = await fetch(`${config.baseUrl ?? "https://gmail.googleapis.com"}/gmail/v1/users/me/profile`, {
        headers: { Authorization: `Bearer ${config.apiKey}` },
      });
      return res.ok;
    } catch {
      return false;
    }
  },
};
