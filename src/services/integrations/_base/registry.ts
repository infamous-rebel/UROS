/**
 * Provider registry — maps (category, provider_name) to adapter instances.
 * Also contains CONNECTOR_TO_ADAPTER: the single source of truth linking
 * DB connector names (api_credentials.connector) to code adapter paths.
 */

import type { Integration } from "./types";

/** A registered adapter entry. */
interface RegistryEntry {
  category: string;
  provider: string;
  adapter: Integration<any, any, any>;
}

/** In-memory registry: keyed by `${category}:${provider}`. */
const registry = new Map<string, RegistryEntry>();

function key(category: string, provider: string): string {
  return `${category}:${provider}`;
}

/** Register an adapter under (category, provider). */
export function registerProvider(
  category: string,
  provider: string,
  adapter: Integration<any, any, any>
): void {
  registry.set(key(category, provider), { category, provider, adapter });
}

/** Retrieve a registered adapter. Returns null if not found. */
export function getProvider(
  category: string,
  provider: string
): Integration<any, any, any> | null {
  return registry.get(key(category, provider))?.adapter ?? null;
}

/** List all registered providers in a category. */
export function listProviders(category: string): string[] {
  const result: string[] = [];
  for (const entry of registry.values()) {
    if (entry.category === category) {
      result.push(entry.provider);
    }
  }
  return result;
}

/** List all registered (category, provider) pairs. */
export function listAllProviders(): Array<{ category: string; provider: string }> {
  return Array.from(registry.values()).map((e) => ({
    category: e.category,
    provider: e.provider,
  }));
}

/** Clear the registry (test-only). */
export function clearRegistry(): void {
  registry.clear();
}

/**
 * CONNECTOR_TO_ADAPTER — maps every ConnectorName DB value to its
 * adapter module path (category + provider). This is the single source
 * of truth for "which code handles which DB connector name."
 *
 * Tested: every ConnectorName has a mapping, every mapping resolves
 * to a real adapter module.
 */
export const CONNECTOR_TO_ADAPTER: Record<string, { category: string; provider: string }> = {
  // SMS providers
  sms_teletalk: { category: "sms", provider: "teletalk" },
  sms_grameenphone: { category: "sms", provider: "grameenphone" },
  sms_banglalink: { category: "sms", provider: "banglalink" },
  sms_robi: { category: "sms", provider: "robi" },
  sms_airtel: { category: "sms", provider: "airtel" },
  sms_ssl_wireless: { category: "sms", provider: "ssl_wireless" },
  sms_alpha_sms: { category: "sms", provider: "alpha_sms" },
  sms_bulk_sms_bd: { category: "sms", provider: "bulk_sms_bd" },
  sms_generic_http: { category: "sms", provider: "generic_http" },

  // VOIP
  voip: { category: "voip", provider: "voip" },

  // Email providers
  email_smtp: { category: "email", provider: "smtp_outbound" },
  email_imap: { category: "email", provider: "imap_inbound" },
  email_gmail_api: { category: "email", provider: "gmail_api" },
  email_graph: { category: "email", provider: "microsoft_graph" },
  email_sendgrid: { category: "email", provider: "sendgrid" },
  email_ses: { category: "email", provider: "amazon_ses" },

  // WhatsApp
  whatsapp_meta: { category: "whatsapp", provider: "meta_cloud_api" },

  // bdjobs
  bdjobs_scraper: { category: "bdjobs", provider: "path_a_session_scraper" },
  bdjobs_csv: { category: "bdjobs", provider: "path_b_csv_import" },
  bdjobs_email: { category: "bdjobs", provider: "path_c_email_intake" },
  bdjobs_webhook: { category: "bdjobs", provider: "path_d_ats_webhook" },

  // LinkedIn
  linkedin: { category: "linkedin", provider: "linkedin" },

  // Calendar
  calendar_google: { category: "calendar", provider: "google" },
  calendar_outlook: { category: "calendar", provider: "microsoft_outlook" },
  calendar_ical: { category: "calendar", provider: "ical" },

  // Teletalk (top-level — government-tenant semantics)
  teletalk_sms: { category: "teletalk", provider: "sms" },
  teletalk_cv_bank: { category: "teletalk", provider: "cv_bank" },

  // Interface-only / free-framework adapters
  free_sms: { category: "free_framework", provider: "free_framework" },
  messaging_telegram: { category: "messaging", provider: "telegram" },
  messaging_viber: { category: "messaging", provider: "viber" },
  messaging_signal: { category: "messaging", provider: "signal" },
};

/** Resolve a DB connector name to its (category, provider) pair. */
export function resolveConnectorName(
  connectorName: string
): { category: string; provider: string } | null {
  return CONNECTOR_TO_ADAPTER[connectorName] ?? null;
}

/** List all known connector names. */
export function listConnectorNames(): string[] {
  return Object.keys(CONNECTOR_TO_ADAPTER);
}
