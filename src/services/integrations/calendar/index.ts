import { requireCredential } from "../credential_store";
import { logAudit } from "../../../utils/audit_helper";
import { logger } from "../../../utils/logger";

export type CalendarProvider = "google" | "outlook";

export interface InterviewEvent {
  candidate_id: string;
  title: string;
  start_time: string; // ISO 8601
  end_time: string; // ISO 8601
  location?: string;
  attendee_emails: string[];
}

export interface CalendarEventResult {
  candidate_id: string;
  provider: CalendarProvider;
  external_event_id: string;
  status: "CREATED" | "FAILED";
}

/**
 * Creates an interview calendar event via Google Calendar or Outlook,
 * using the org's BYOK OAuth token. Scheduling itself is a low-risk,
 * pre-approved automation (the recruiter already confirmed the interview
 * slot in the Human Review Dashboard before this is called) — it does not
 * decide who gets an interview.
 */
export async function createInterviewEvent(
  orgId: string,
  provider: CalendarProvider,
  event: InterviewEvent
): Promise<CalendarEventResult> {
  const { apiKey, baseUrl } = await requireCredential(orgId, "calendar", provider);

  const endpoint =
    provider === "google"
      ? `${baseUrl ?? "https://www.googleapis.com/calendar/v3"}/calendars/primary/events`
      : `${baseUrl ?? "https://graph.microsoft.com/v1.0"}/me/events`;

  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(toProviderPayload(provider, event)),
    });
    if (!res.ok) throw new Error(`${provider} calendar API responded ${res.status}: ${res.statusText}`);
    const body = (await res.json()) as { id: string };

    await logAudit({
      entity_type: "CALENDAR_EVENT",
      entity_id: event.candidate_id,
      agent_or_user: "CalendarConnector",
      action: "INTERVIEW_SCHEDULED",
      output_value: { provider, external_event_id: body.id, start_time: event.start_time },
    });

    return { candidate_id: event.candidate_id, provider, external_event_id: body.id, status: "CREATED" };
  } catch (err) {
    logger.error("CALENDAR_EVENT_CREATE_FAILED", {
      candidate_id: event.candidate_id,
      provider,
      error: err instanceof Error ? err.message : String(err),
    });
    return { candidate_id: event.candidate_id, provider, external_event_id: "", status: "FAILED" };
  }
}

function toProviderPayload(provider: CalendarProvider, event: InterviewEvent) {
  if (provider === "google") {
    return {
      summary: event.title,
      location: event.location,
      start: { dateTime: event.start_time },
      end: { dateTime: event.end_time },
      attendees: event.attendee_emails.map((email) => ({ email })),
    };
  }
  return {
    subject: event.title,
    location: { displayName: event.location ?? "" },
    start: { dateTime: event.start_time, timeZone: "Asia/Dhaka" },
    end: { dateTime: event.end_time, timeZone: "Asia/Dhaka" },
    attendees: event.attendee_emails.map((email) => ({ emailAddress: { address: email }, type: "required" })),
  };
}
