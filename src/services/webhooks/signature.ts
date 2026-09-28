import { createHmac, timingSafeEqual } from "crypto";

/**
 * Verifies an HMAC-SHA256 webhook signature over the raw request body.
 * Expected header format: "sha256=<hex digest>" (GitHub/Meta convention).
 * Uses constant-time comparison to avoid timing side-channels.
 */
export function verifyWebhookSignature(
  rawBody: Buffer | string,
  signatureHeader: string | undefined,
  secret: string
): boolean {
  if (!signatureHeader) return false;

  const expected = "sha256=" + createHmac("sha256", secret).update(rawBody).digest("hex");

  const expectedBuf = Buffer.from(expected, "utf8");
  const actualBuf = Buffer.from(signatureHeader, "utf8");

  if (expectedBuf.length !== actualBuf.length) return false;
  return timingSafeEqual(expectedBuf, actualBuf);
}
