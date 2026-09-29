/**
 * Password hashing + policy — Quest 05 Decision Lock 1.
 *
 * bcryptjs (pure JS) is used instead of native bcrypt so air-gapped
 * on-prem installs never need a C toolchain: the algorithm is identical
 * (bcrypt), only the implementation differs. Hashing happens only on the
 * login / change / reset paths, never on hot loops, so the pure-JS
 * performance profile is acceptable.
 *
 * Stated assumption (Decision Lock 1 does not define a strength policy):
 * minimum 10 characters, and the password must not be the user's own
 * email (local part or full). Nothing else is enforced — complexity
 * rules disproportionately hurt non-Latin-script users.
 */
import bcrypt from "bcryptjs";

/** bcrypt cost factor. 12 ≈ 250ms on commodity hardware in pure JS. */
const BCRYPT_ROUNDS = 12;

export function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, BCRYPT_ROUNDS);
}

export function verifyPassword(plain: string, hash: string | null): Promise<boolean> {
  // When no hash exists the account has never set a password — compare
  // against a fixed dummy hash so response timing does not reveal
  // whether the email exists (anti-enumeration).
  const DUMMY_HASH = "$2a$12$C6UzMDM.H6dfI/f/IKcEeO1Io3FmiKlj/g7B0Dqp2efypxqFN3O5W";
  return bcrypt.compare(plain, hash ?? DUMMY_HASH);
}

/** Returns a human-readable policy message, or null when the password is acceptable. */
export function passwordPolicyError(plain: string, email: string | null): string | null {
  if (plain.length < 10) {
    return "Password must be at least 10 characters long.";
  }
  if (email) {
    const local = email.split("@")[0]?.toLowerCase() ?? "";
    const lowered = plain.toLowerCase();
    if (lowered === email.toLowerCase() || (local.length >= 3 && lowered.includes(local))) {
      return "Password must not be based on your email address.";
    }
  }
  return null;
}
