/**
 * SMTP outbound email adapter (email:smtp_outbound).
 * Real SMTP transport via nodemailer. Credential format (BYOK):
 * - apiKey: SMTP username and password joined as "username:password"
 * - baseUrl: "smtp://host:port" (587/25, STARTTLS when supported) or
 *   "smtps://host:port" (465, implicit TLS).
 */

import nodemailer from "nodemailer";
import { Integration, IntegrationResult, EmailInput, EmailOutput } from "../_base/types";
import { HttpProviderConfig } from "../sms/shared";

export interface SmtpConnectionInfo {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  pass: string;
}

/** Parses the BYOK baseUrl + apiKey into nodemailer transport options. */
export function parseSmtpConfig(config: HttpProviderConfig): SmtpConnectionInfo {
  if (!config.baseUrl) {
    throw new Error(
      "SMTP credential is malformed: base_url is required (format smtp://host:port or smtps://host:port)."
    );
  }
  let url: URL;
  try {
    url = new URL(config.baseUrl);
  } catch {
    throw new Error(`SMTP credential is malformed: base_url '${config.baseUrl}' is not a valid URL.`);
  }
  if (url.protocol !== "smtp:" && url.protocol !== "smtps:") {
    throw new Error(`SMTP credential is malformed: base_url protocol must be smtp: or smtps:, got '${url.protocol}'`);
  }
  const sep = config.apiKey.indexOf(":");
  if (sep <= 0) {
    throw new Error("SMTP credential is malformed: apiKey must be 'username:password'.");
  }
  return {
    host: url.hostname,
    port: Number(url.port) || (url.protocol === "smtps:" ? 465 : 587),
    secure: url.protocol === "smtps:",
    user: config.apiKey.slice(0, sep),
    pass: config.apiKey.slice(sep + 1),
  };
}

/** Builds the MIME-ready message from the uniform EmailInput. */
export function toNodemailerMessage(input: EmailInput) {
  return {
    from: input.from,
    to: input.to,
    subject: input.subject,
    text: input.body_text,
    html: input.body_html,
    attachments: input.attachments?.map((a) => ({
      filename: a.filename,
      contentType: a.content_type,
      content: a.data,
    })),
  };
}

export const smtpOutboundAdapter: Integration<HttpProviderConfig, EmailInput, EmailOutput> = {
  name: "smtp_outbound",
  async send(input: EmailInput, config: HttpProviderConfig): Promise<IntegrationResult<EmailOutput>> {
    const conn = parseSmtpConfig(config);
    const transporter = nodemailer.createTransport({
      host: conn.host,
      port: conn.port,
      secure: conn.secure,
      auth: { user: conn.user, pass: conn.pass },
    });
    try {
      const info = await transporter.sendMail(toNodemailerMessage(input));
      return { status: "SENT", provider_id: info.messageId, data: { provider_message_id: info.messageId } };
    } catch (err) {
      // SMTP failures (auth rejection 535, mailbox errors) and connection
      // errors are indistinguishable at this layer; surface as FAILED with
      // the SMTP code when present. Connection errors also FAILED (not
      // thrown) so the dispatcher's fallback chain can move to the next
      // email provider rather than retrying the same broken relay.
      const message = err instanceof Error ? err.message : String(err);
      const code = (err as { code?: string }).code ?? "SMTP_ERROR";
      return { status: "FAILED", error_code: code, error_message: message };
    }
  },
  async healthCheck(config: HttpProviderConfig): Promise<boolean> {
    try {
      const conn = parseSmtpConfig(config);
      const transporter = nodemailer.createTransport({
        host: conn.host,
        port: conn.port,
        secure: conn.secure,
        auth: { user: conn.user, pass: conn.pass },
        connectionTimeout: 5_000,
      });
      await transporter.verify();
      return true;
    } catch {
      return false;
    }
  },
};
