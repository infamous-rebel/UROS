export type ConnectorName =
  | "teletalk" | "bdjobs" | "linkedin" | "email"
  | "sms_provider" | "whatsapp_business" | "calendar"
  | "education_board" | "cib" | "police"
  | "llm"; // optional, BYOK-only rephrasing for Improvement Advisor; not yet in the api_credentials CHECK constraint — queries return null until a future migration widens it and a route allows storing one

export interface ApiCredential {
  credential_id: string;
  org_id: string;
  connector: ConnectorName;
  label: string;
  encrypted_value: string;
  iv: string;
  auth_tag: string;
  base_url: string | null;
  active: boolean;
  created_by: string | null;
  created_at: string;
  rotated_at: string | null;
}
