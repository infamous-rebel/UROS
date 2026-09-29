/**
 * Amazon SES email adapter (email:amazon_ses).
 * SESv2 SendEmail with AWS Signature Version 4 (no SDK dependency —
 * deterministic crypto from node:crypto).
 * Credential format (BYOK):
 * - apiKey: SES access key id joined to secret key as "<access_key>:<secret_key>"
 * - baseUrl: https://email.<region>.amazonaws.com — region is part of the
 *   credential and REQUIRED (no silent default region).
 */

import crypto from "crypto";
import { Integration, IntegrationResult, EmailInput, EmailOutput } from "../_base/types";
import { HttpProviderConfig } from "../sms/shared";

export interface SesCredentials {
  accessKey: string;
  secretKey: string;
  region: string;
  host: string;
}

export function parseSesConfig(config: HttpProviderConfig): SesCredentials {
  if (!config.baseUrl) {
    throw new Error("SES credential is malformed: base_url is required (format https://email.<region>.amazonaws.com).");
  }
  let url: URL;
  try {
    url = new URL(config.baseUrl);
  } catch {
    throw new Error(`SES credential is malformed: base_url '${config.baseUrl}' is not a valid URL.`);
  }
  const match = url.hostname.match(/^email\.([a-z0-9-]+)\.amazonaws\.com$/);
  if (!match) {
    throw new Error(`SES credential is malformed: base_url host must be email.<region>.amazonaws.com, got '${url.hostname}'`);
  }
  const sep = config.apiKey.indexOf(":");
  if (sep <= 0) {
    throw new Error("SES credential is malformed: apiKey must be '<access_key>:<secret_key>'.");
  }
  return { accessKey: config.apiKey.slice(0, sep), secretKey: config.apiKey.slice(sep + 1), region: match[1], host: url.hostname };
}

function hmac(key: crypto.BinaryLike | Buffer, data: string): Buffer {
  return crypto.createHmac("sha256", key).update(data, "utf8").digest();
}

function sha256Hex(data: string | Buffer): string {
  return crypto.createHash("sha256").update(data).digest("hex");
}

/**
 * Computes the AWS SigV4 Authorization header for a request.
 * Exported for deterministic unit testing against AWS's published
 * signature test vectors.
 */
export function signAwsRequest(
  method: string,
  path: string,
  body: string,
  creds: SesCredentials,
  amzDate: string
): { authorization: string; payloadHash: string } {
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = sha256Hex(body);
  const canonicalHeaders =
    `content-type:application/json\n` +
    `host:${creds.host}\n` +
    `x-amz-content-sha256:${payloadHash}\n` +
    `x-amz-date:${amzDate}\n`;
  const signedHeaders = "content-type;host;x-amz-content-sha256;x-amz-date";

  const canonicalRequest = [method, path, "", canonicalHeaders, signedHeaders, payloadHash].join("\n");

  const scope = `${dateStamp}/${creds.region}/ses/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256Hex(canonicalRequest)].join("\n");

  const kDate = hmac(`AWS4${creds.secretKey}`, dateStamp);
  const kRegion = hmac(kDate, creds.region);
  const kService = hmac(kRegion, "ses");
  const kSigning = hmac(kService, "aws4_request");
  const signature = crypto.createHmac("sha256", kSigning).update(stringToSign, "utf8").digest("hex");

  const authorization = `AWS4-HMAC-SHA256 Credential=${creds.accessKey}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return { authorization, payloadHash };
}

export const amazonSesAdapter: Integration<HttpProviderConfig, EmailInput, EmailOutput> = {
  name: "amazon_ses",
  async send(input: EmailInput, config: HttpProviderConfig): Promise<IntegrationResult<EmailOutput>> {
    const creds = parseSesConfig(config);
    const body = JSON.stringify({
      FromEmailAddress: input.from,
      Destination: { ToAddresses: [input.to] },
      Content: {
        Simple: {
          Subject: { Data: input.subject, Charset: "UTF-8" },
          Body: {
            Text: { Data: input.body_text, Charset: "UTF-8" },
            ...(input.body_html ? { Html: { Data: input.body_html, Charset: "UTF-8" } } : {}),
          },
        },
      },
    });

    const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, "");
    const { authorization, payloadHash } = signAwsRequest("POST", "/v2/email/outbound-emails", body, creds, amzDate);

    let res: Response;
    try {
      res = await fetch(`https://${creds.host}/v2/email/outbound-emails`, {
        method: "POST",
        headers: {
          Authorization: authorization,
          "Content-Type": "application/json",
          "X-Amz-Date": amzDate,
          "X-Amz-Content-Sha256": payloadHash,
        },
        body,
      });
    } catch (err) {
      throw err instanceof Error ? err : new Error(String(err));
    }

    if (!res.ok) {
      return {
        status: "FAILED",
        error_code: `SES_HTTP_${res.status}`,
        error_message: `Amazon SES responded ${res.status}: ${res.statusText}`,
      };
    }
    const resBody = (await res.json()) as { MessageId?: string };
    return {
      status: "SENT",
      provider_id: resBody.MessageId,
      data: { provider_message_id: resBody.MessageId ?? "" },
    };
  },
  async healthCheck(config: HttpProviderConfig): Promise<boolean> {
    try {
      const creds = parseSesConfig(config);
      // GET /v2/account is the cheapest authenticated probe.
      const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, "");
      const { authorization, payloadHash } = signAwsRequest("GET", "/v2/account", "", creds, amzDate);
      const res = await fetch(`https://${creds.host}/v2/account`, {
        headers: {
          Authorization: authorization,
          "X-Amz-Date": amzDate,
          "X-Amz-Content-Sha256": payloadHash,
        },
      });
      return res.ok;
    } catch {
      return false;
    }
  },
};
