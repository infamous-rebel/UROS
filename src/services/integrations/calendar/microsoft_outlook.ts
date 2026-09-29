/**
 * Microsoft Outlook Calendar adapter (calendar:microsoft_outlook).
 * Creates interview events via Microsoft Graph with the org's BYOK OAuth
 * token. Canonical host: https://graph.microsoft.com/v1.0.
 */

import { Integration, IntegrationResult } from "../_base/types";
import { HttpProviderConfig } from "../sms/shared";
import type { CalendarEventInput, CalendarEventOutput } from "../calendar/google";

export function toOutlookEventPayload(event: CalendarEventInput) {
  return {
    subject: event.title,
    location: { displayName: event.location ?? "" },
    start: { dateTime: event.start_time, timeZone: "Asia/Dhaka" },
    end: { dateTime: event.end_time, timeZone: "Asia/Dhaka" },
    attendees: event.attendee_emails.map((email) => ({ emailAddress: { address: email }, type: "required" })),
  };
}

export const outlookCalendarAdapter: Integration<HttpProviderConfig, CalendarEventInput, CalendarEventOutput> = {
  name: "microsoft_outlook",
  async send(input: CalendarEventInput, config: HttpProviderConfig): Promise<IntegrationResult<CalendarEventOutput>> {
    let res: Response;
    try {
      res = await fetch(`${config.baseUrl ?? "https://graph.microsoft.com/v1.0"}/me/events`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${config.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(toOutlookEventPayload(input)),
      });
    } catch (err) {
      throw err instanceof Error ? err : new Error(String(err));
    }
    if (!res.ok) {
      return {
        status: "FAILED",
        error_code: `OUTLOOK_HTTP_${res.status}`,
        error_message: `Outlook Calendar responded ${res.status}: ${res.statusText}`,
      };
    }
    const body = (await res.json()) as { id?: string };
    if (!body.id) {
      return { status: "FAILED", error_code: "OUTLOOK_MISSING_EVENT_ID", error_message: "Outlook response missing event id." };
    }
    return { status: "SENT", provider_id: body.id, data: { external_event_id: body.id } };
  },
  async healthCheck(config: HttpProviderConfig): Promise<boolean> {
    try {
      const res = await fetch(`${config.baseUrl ?? "https://graph.microsoft.com/v1.0"}/me`, {
        headers: { Authorization: `Bearer ${config.apiKey}` },
      });
      return res.ok;
    } catch {
      return false;
    }
  },
};
