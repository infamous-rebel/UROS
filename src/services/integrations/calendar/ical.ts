/**
 * iCalendar adapter (calendar:ical).
 * Renders an RFC 5545 ICS invite for the interview event. No network —
 * the ICS payload is the deliverable; the caller attaches it to an email
 * or hands it to the applicant portal. healthCheck is trivially true.
 */

import crypto from "crypto";
import { Integration, IntegrationResult } from "../_base/types";
import { HttpProviderConfig } from "../sms/shared";
import type { CalendarEventInput } from "../calendar/google";

export interface IcsEventOutput {
  /** RFC 5545 calendar payload (text/calendar). */
  ics: string;
  uid: string;
}

/** Folds an ICS content line at 75 octets per RFC 5545 §3.1. */
export function foldIcsLine(line: string): string {
  if (line.length <= 75) return line;
  const out: string[] = [];
  let rest = line;
  out.push(rest.slice(0, 75));
  rest = rest.slice(75);
  while (rest.length > 0) {
    out.push(` ${rest.slice(0, 74)}`);
    rest = rest.slice(74);
  }
  return out.join("\r\n");
}

/** Renders the RFC 5545 VEVENT for the input. */
export function toIcs(event: CalendarEventInput): IcsEventOutput {
  const uid = `${crypto.randomUUID()}@uros`;
  const dt = (iso: string) => iso.replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//UROS//Interview Scheduling//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:REQUEST",
    "BEGIN:VEVENT",
    `UID:${uid}`,
    `DTSTAMP:${dt(new Date().toISOString())}`,
    `DTSTART:${dt(event.start_time)}`,
    `DTEND:${dt(event.end_time)}`,
    `SUMMARY:${event.title}`,
    ...(event.location ? [`LOCATION:${event.location}`] : []),
    `DESCRIPTION:Interview for candidate ${event.candidate_id}`,
    ...event.attendee_emails.map((email) => `ATTENDEE;ROLE=REQ-PARTICIPANT:mailto:${email}`),
    "END:VEVENT",
    "END:VCALENDAR",
  ];
  return { ics: lines.map(foldIcsLine).join("\r\n"), uid };
}

export const icalAdapter: Integration<HttpProviderConfig, CalendarEventInput, IcsEventOutput> = {
  name: "ical",
  async send(input: CalendarEventInput, _config: HttpProviderConfig): Promise<IntegrationResult<IcsEventOutput>> {
    void _config;
    const out = toIcs(input);
    return { status: "SENT", provider_id: out.uid, data: out };
  },
  async healthCheck(): Promise<boolean> {
    // Stateless renderer — nothing to probe.
    return true;
  },
};
