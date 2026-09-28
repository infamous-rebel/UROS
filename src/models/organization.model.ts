export type Sector =
  | "GOVT_NONCADRE" | "BCS" | "STATE_BANK" | "PRIVATE_BANK"
  | "CORPORATE" | "NGO" | "SME";
export type DeploymentMode = "ON_PREM" | "CLOUD" | "HYBRID";

/** Feature 5: Multi-Language Interface and Document Support. */
export type SupportedLanguage = "en" | "bn";

export interface Organization {
  org_id: string;
  name: string;
  sector: Sector;
  deployment_mode: DeploymentMode;
  /** Fallback UI/communication language when a user or candidate has no personal preference. */
  default_language: SupportedLanguage;
  created_at: string;
}
