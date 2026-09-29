/**
 * Opaque token generation + hashing for refresh and password-reset flows.
 *
 * Tokens are 256 bits of CSPRNG entropy, base64url-encoded. Only the
 * SHA-256 hash is ever stored — a database leak cannot be replayed as a
 * live token. Raw tokens exist exactly twice: at issue (returned to the
 * client / embedded in a reset link) and in the in-memory response path.
 */
import { createHash, randomBytes } from "crypto";

/** 256-bit URL-safe opaque token. */
export function generateToken(): string {
  return randomBytes(32).toString("base64url");
}

/** SHA-256 hex digest — the only form of a token that is ever persisted. */
export function hashToken(raw: string): string {
  return createHash("sha256").update(raw, "utf8").digest("hex");
}
