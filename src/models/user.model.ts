import { SupportedLanguage } from "./organization.model";

export type UserRole =
  | "ADMIN" | "RECRUITER" | "SENIOR_RECRUITER" | "AUDITOR"
  | "DEPT_HEAD" | "APPLICANT" | "SYSTEM_AGENT";

export interface User {
  user_id: string;
  org_id: string;
  full_name: string;
  email: string | null;
  role: UserRole;
  dept_scope: string | null;
  active: boolean;
  /** Feature 5: personal dashboard language override; null = follow organizations.default_language. */
  preferred_language: SupportedLanguage | null;
  created_at: string;
}
