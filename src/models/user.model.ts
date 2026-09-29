import { SupportedLanguage } from "./organization.model";

export type UserRole =
  | "ADMIN" | "RECRUITER" | "SENIOR_RECRUITER" | "AUDITOR"
  | "DEPT_HEAD" | "APPLICANT" | "SYSTEM_AGENT";

export interface User {
  user_id: string;
  org_id: string;
  full_name: string;
  email: string | null;
  /** Quest 05: used for SMS-first password-reset link delivery (Decision Lock 1). */
  phone: string | null;
  /** bcrypt hash; NULL until the account sets a password via a reset/invite link. */
  password_hash: string | null;
  email_verified_at: string | null;
  /** Quest 05 Decision Lock 1: first-login reset — must complete the set-password flow before signing in. */
  password_reset_required: boolean;
  role: UserRole;
  dept_scope: string | null;
  active: boolean;
  /** Feature 5: personal dashboard language override; null = follow organizations.default_language. */
  preferred_language: SupportedLanguage | null;
  created_at: string;
}
