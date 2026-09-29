/**
 * Google Calendar adapter (calendar:google).
 * Creates interview events via the Google Calendar v3 API with the org's
 * BYOK OAuth token. Canonical host: https://www.googleapis.com/calendar/v3.
 */

import { Integration, IntegrationResult } from "../_base/types";
import { HttpProviderConfig } from "../sms/shared";

export interface CalendarEventInput {
  candidate_id: string;
  title: string;
  start_time: string;
  end_time: string;
  location?: string;
  attendee_emails: string[];
}

export interface CalendarEventOutput {
  external_event_id: string;
}

export function toGoogleEventPayload(event: CalendarEventInput) {
  return {
    summary: event.title,
    location: event.location,
    start: { dateTime: event.start_time },
    end: { dateTime: event.end_time },
    attendees: event.attendee_emails.map((email) => ({ email })),
  };
}

export const googleCalendarAdapter: Integration<HttpProviderConfig, CalendarEventInput, CalendarEventOutput> = {
  name: "google",
  async send(input: CalendarEventInput, config: HttpProviderConfig): Promise<IntegrationResult<CalendarEventOutput>> {
    let res: Response;
    try {
      res = await fetch(`${config.baseUrl ?? "https://www.googleapis.com/calendar/v3"}/calendars/primary/events`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${config.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(toGoogleEventPayload(input)),
      });
    } catch (err) {
      throw err instanceof Error ? err : new Error(String(err));
    }
    if (!res.ok) {
      return {
        status: "FAILED",
        error_code: `GCAL_HTTP_${res.status}`,
        error_message: `Google Calendar responded ${res.status}: ${res.statusText}`,
      };
    }
    const body = (await res.json()) as { id?: string };
    if (!body.id) {
      return { status: "FAILED", error_code: "GCAL_MISSING_EVENT_ID", error_message: "Google Calendar response missing event id." };
    }
    return { status: "SENT", provider_id: body.id, data: { external_event_id: body.id } };
  },
  async healthCheck(config: HttpProviderConfig): Promise<boolean> {
    try {
      const res = await fetch(`${config.baseUrl ?? "https://www.googleapis.com/calendar/v3"}/users/me/calendarList?maxResults=1`, {
        headers: { Authorization: `Bearer ${config.apiKey}` },
      });
      return res.ok;
    } catch {
      return false;
    }
  },
};
