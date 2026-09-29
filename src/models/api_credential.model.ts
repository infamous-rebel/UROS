export type ConnectorName =
  // Legacy connector names (pre-Quest 04)
  | "teletalk" | "bdjobs" | "linkedin" | "email"
  | "sms_provider" | "whatsapp_business" | "calendar"
  | "education_board" | "cib" | "police"
  | "llm"
  // Quest 04 — SMS providers
  | "sms_teletalk" | "sms_grameenphone" | "sms_banglalink" | "sms_robi" | "sms_airtel"
  | "sms_ssl_wireless" | "sms_alpha_sms" | "sms_bulk_sms_bd" | "sms_generic_http"
  // Quest 04 — VOIP
  | "voip"
  // Quest 04 — Email providers
  | "email_smtp" | "email_imap" | "email_gmail_api" | "email_graph" | "email_sendgrid" | "email_ses"
  // Quest 04 — WhatsApp
  | "whatsapp_meta"
  // Quest 04 — bdjobs
  | "bdjobs_scraper" | "bdjobs_csv" | "bdjobs_email" | "bdjobs_webhook"
  // Quest 04 — Calendar
  | "calendar_google" | "calendar_outlook" | "calendar_ical"
  // Quest 04 — Teletalk (top-level)
  | "teletalk_sms" | "teletalk_cv_bank"
  // Quest 04 — Interface-only / free-framework
  | "free_sms" | "messaging_telegram" | "messaging_viber" | "messaging_signal";

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
