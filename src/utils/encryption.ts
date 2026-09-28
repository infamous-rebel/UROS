import { randomBytes, createCipheriv, createDecipheriv } from "crypto";
import { env } from "../config/env.schema";

const ALGORITHM = "aes-256-gcm";

export interface EncryptedPayload {
  encrypted_value: string; // base64
  iv: string; // base64
  auth_tag: string; // base64
}

function getKeyBuffer(): Buffer {
  const key = Buffer.from(env.ENCRYPTION_KEY, "hex");
  if (key.length !== 32) {
    throw new Error("ENCRYPTION_KEY must decode to exactly 32 bytes (64 hex chars) for AES-256-GCM");
  }
  return key;
}

/** Encrypts a plaintext secret (e.g. a connector API key) for storage. */
export function encryptSecret(plaintext: string): EncryptedPayload {
  const iv = randomBytes(12); // GCM standard nonce size
  const cipher = createCipheriv(ALGORITHM, getKeyBuffer(), iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return {
    encrypted_value: encrypted.toString("base64"),
    iv: iv.toString("base64"),
    auth_tag: authTag.toString("base64"),
  };
}

/** Decrypts a stored secret. Throws if the auth tag does not match (tampered/corrupt). */
export function decryptSecret(payload: EncryptedPayload): string {
  const decipher = createDecipheriv(ALGORITHM, getKeyBuffer(), Buffer.from(payload.iv, "base64"));
  decipher.setAuthTag(Buffer.from(payload.auth_tag, "base64"));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(payload.encrypted_value, "base64")),
    decipher.final(),
  ]);
  return decrypted.toString("utf8");
}

/**
 * Produces a display-safe masked representation of a secret, computed
 * once at write time and stored as `key_hint` — callers never decrypt a
 * credential just to display it. Never returns enough of the original
 * value to reconstruct it: short secrets are fully masked.
 */
export function maskSecret(plaintext: string): string {
  const len = plaintext.length;
  if (len <= 8) return "*".repeat(len);
  const prefix = plaintext.slice(0, 4);
  const suffix = plaintext.slice(-4);
  return `${prefix}${"*".repeat(Math.max(4, len - 8))}${suffix}`;
}
