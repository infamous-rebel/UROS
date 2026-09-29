/**
 * Central registration of every built-in integration adapter.
 *
 * Called once at process boot (API server, queue worker, schedulers) so
 * the registry can resolve every CONNECTOR_TO_ADAPTER entry before the
 * first dispatch. Idempotent — safe to import from multiple entrypoints.
 */

import { registerProvider } from "./_base/registry";

// SMS
import { teletalkAdapter } from "./sms/teletalk";
import { grameenphoneAdapter } from "./sms/grameenphone";
import { banglalinkAdapter } from "./sms/banglalink";
import { robiAdapter } from "./sms/robi";
import { airtelAdapter } from "./sms/airtel";
import { sslWirelessAdapter } from "./sms/ssl_wireless";
import { alphaSmsAdapter } from "./sms/alpha_sms";
import { bulkSmsBdAdapter } from "./sms/bulk_sms_bd";
import { genericHttpAdapter } from "./sms/generic_http";

// VOIP
import { voipAdapter } from "./voip/voip";

// Email
import { smtpOutboundAdapter } from "./email/smtp_outbound";
import { gmailApiAdapter } from "./email/gmail_api";
import { microsoftGraphAdapter } from "./email/microsoft_graph";
import { sendgridAdapter } from "./email/sendgrid";
import { amazonSesAdapter } from "./email/amazon_ses";
import { imapInboundAdapter } from "./email/imap_inbound";

// WhatsApp
import { metaCloudApiAdapter } from "./whatsapp/meta_cloud_api";

// bdjobs
import { bdjobsSessionScraperAdapter } from "./bdjobs/path_a_session_scraper";
import { bdjobsCsvImportAdapter } from "./bdjobs/path_b_csv_import";
import { bdjobsEmailIntakeAdapter } from "./bdjobs/path_c_email_intake";
import { bdjobsAtsWebhookAdapter } from "./bdjobs/path_d_ats_webhook";

// LinkedIn
import { linkedinAdapter } from "./linkedin/linkedin";

// Calendar
import { googleCalendarAdapter } from "./calendar/google";
import { outlookCalendarAdapter } from "./calendar/microsoft_outlook";
import { icalAdapter } from "./calendar/ical";

// Teletalk (government-tenant category)
import { teletalkSmsAdapter } from "./teletalk/sms";
import { teletalkCvBankAdapter } from "./teletalk/cv_bank";

// Interface-only / free-framework
import { freeFrameworkAdapter } from "./free_framework/free_framework";
import { telegramAdapter } from "./messaging/telegram";
import { viberAdapter } from "./messaging/viber";
import { signalAdapter } from "./messaging/signal";

/**
 * Registers every built-in adapter. Idempotent by construction — each
 * registerProvider call overwrites the same registry key, so calling it
 * multiple times (multiple boot entrypoints, or after a registry reset)
 * always converges to exactly one adapter per mapping.
 */
export function registerAllProviders(): void {
  registerProvider("sms", "teletalk", teletalkAdapter);
  registerProvider("sms", "grameenphone", grameenphoneAdapter);
  registerProvider("sms", "banglalink", banglalinkAdapter);
  registerProvider("sms", "robi", robiAdapter);
  registerProvider("sms", "airtel", airtelAdapter);
  registerProvider("sms", "ssl_wireless", sslWirelessAdapter);
  registerProvider("sms", "alpha_sms", alphaSmsAdapter);
  registerProvider("sms", "bulk_sms_bd", bulkSmsBdAdapter);
  registerProvider("sms", "generic_http", genericHttpAdapter);

  registerProvider("voip", "voip", voipAdapter);

  registerProvider("email", "smtp_outbound", smtpOutboundAdapter);
  registerProvider("email", "gmail_api", gmailApiAdapter);
  registerProvider("email", "microsoft_graph", microsoftGraphAdapter);
  registerProvider("email", "sendgrid", sendgridAdapter);
  registerProvider("email", "amazon_ses", amazonSesAdapter);
  registerProvider("email", "imap_inbound", imapInboundAdapter);

  registerProvider("whatsapp", "meta_cloud_api", metaCloudApiAdapter);

  registerProvider("bdjobs", "path_a_session_scraper", bdjobsSessionScraperAdapter);
  registerProvider("bdjobs", "path_b_csv_import", bdjobsCsvImportAdapter);
  registerProvider("bdjobs", "path_c_email_intake", bdjobsEmailIntakeAdapter);
  registerProvider("bdjobs", "path_d_ats_webhook", bdjobsAtsWebhookAdapter);

  registerProvider("linkedin", "linkedin", linkedinAdapter);

  registerProvider("calendar", "google", googleCalendarAdapter);
  registerProvider("calendar", "microsoft_outlook", outlookCalendarAdapter);
  registerProvider("calendar", "ical", icalAdapter);

  registerProvider("teletalk", "sms", teletalkSmsAdapter);
  registerProvider("teletalk", "cv_bank", teletalkCvBankAdapter);

  registerProvider("free_framework", "free_framework", freeFrameworkAdapter);
  registerProvider("messaging", "telegram", telegramAdapter);
  registerProvider("messaging", "viber", viberAdapter);
  registerProvider("messaging", "signal", signalAdapter);
}
