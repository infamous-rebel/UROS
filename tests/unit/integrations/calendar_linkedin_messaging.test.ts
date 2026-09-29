/**
 * Quest 04 — Calendar, LinkedIn, and interface-only messaging adapter
 * tests. Calendar + LinkedIn run against the HTTP mock; iCal is a pure
 * renderer verified against RFC 5545 structural rules; interface-only
 * adapters prove the Rule 18 exception contract (loud
 * ProviderNotImplementedError, never a silent no-op).
 */
import * as fs from "fs";
import * as path from "path";
import { HttpProviderMock } from "../../mocks/http_provider_mock";
import { HttpProviderConfig } from "../../../src/services/integrations/sms/shared";
import { ProviderNotImplementedError } from "../../../src/services/integrations/_base/types";
import { googleCalendarAdapter, toGoogleEventPayload } from "../../../src/services/integrations/calendar/google";
import { outlookCalendarAdapter, toOutlookEventPayload } from "../../../src/services/integrations/calendar/microsoft_outlook";
import { icalAdapter, foldIcsLine, toIcs } from "../../../src/services/integrations/calendar/ical";
import { linkedinAdapter } from "../../../src/services/integrations/linkedin/linkedin";
import { freeFrameworkAdapter } from "../../../src/services/integrations/free_framework/free_framework";
import { telegramAdapter } from "../../../src/services/integrations/messaging/telegram";
import { viberAdapter } from "../../../src/services/integrations/messaging/viber";
import { signalAdapter } from "../../../src/services/integrations/messaging/signal";

function cfg(baseUrl: string | null, apiKey = "key-12345678"): HttpProviderConfig {
  return { apiKey, baseUrl, orgId: "org-test" };
}

const EVENT = {
  candidate_id: "CAND-9",
  title: "Technical interview — Nusrat Jahan",
  start_time: "2026-10-05T10:00:00Z",
  end_time: "2026-10-05T11:00:00Z",
  location: "Dhaka HQ / Room 4",
  attendee_emails: ["nusrat@example.com", "panel@uros.test"],
};

describe("Google Calendar adapter", () => {
  let mock: HttpProviderMock;

  beforeAll(async () => {
    mock = new HttpProviderMock();
    await mock.start();
    mock.setRoutes([
      { path: "/calendars/primary/events", status: 200, body: JSON.stringify({ id: "gcal-evt-1", htmlLink: "https://cal/x" }) },
    ]);
  });
  afterAll(async () => mock.stop());

  it("creates the event with attendees → SENT with external id", async () => {
    const res = await googleCalendarAdapter.send(EVENT, cfg(mock.baseUrl()));
    expect(res.status).toBe("SENT");
    expect((res as any).data).toEqual({ external_event_id: "gcal-evt-1" });
    expect(mock.lastRequest().json).toEqual(toGoogleEventPayload(EVENT));
  });

  it("4xx → FAILED GCAL_HTTP_<status>; missing event id → GCAL_MISSING_EVENT_ID", async () => {
    mock.setRoutes([{ path: "/calendars/primary/events", status: 403, body: "forbidden" }]);
    expect(await googleCalendarAdapter.send(EVENT, cfg(mock.baseUrl())))
      .toMatchObject({ status: "FAILED", error_code: "GCAL_HTTP_403" });

    mock.setRoutes([{ path: "/calendars/primary/events", status: 200, body: JSON.stringify({}) }]);
    expect(await googleCalendarAdapter.send(EVENT, cfg(mock.baseUrl())))
      .toMatchObject({ status: "FAILED", error_code: "GCAL_MISSING_EVENT_ID" });
  });
});

describe("Outlook Calendar adapter", () => {
  let mock: HttpProviderMock;

  beforeAll(async () => {
    mock = new HttpProviderMock();
    await mock.start();
    mock.setRoutes([
      { path: "/me/events", status: 201, body: JSON.stringify({ id: "outlook-evt-1" }) },
    ]);
  });
  afterAll(async () => mock.stop());

  it("creates the event → SENT with external id", async () => {
    const res = await outlookCalendarAdapter.send(EVENT, cfg(mock.baseUrl()));
    expect(res.status).toBe("SENT");
    expect((res as any).data.external_event_id).toBe("outlook-evt-1");
    expect(mock.lastRequest().json).toEqual(toOutlookEventPayload(EVENT));
  });
});

describe("iCal adapter (pure RFC 5545 rendering)", () => {
  it("foldIcsLine folds lines longer than 75 octets with CRLF + single space", () => {
    const long = "DESCRIPTION:" + "x".repeat(200);
    const folded = foldIcsLine(long);
    const segments = folded.split("\r\n");
    expect(segments.length).toBeGreaterThan(1);
    expect(segments[0]).toHaveLength(75);
    // Every continuation line begins with exactly one space (RFC 5545 §3.1).
    for (const continuation of segments.slice(1)) {
      expect(continuation[0]).toBe(" ");
      expect(continuation.length).toBeLessThanOrEqual(75);
    }
    // Unfolding (removing CRLF + the leading space) restores the original.
    expect(folded.replace(/\r\n /g, "")).toBe(long);
  });

  it("foldIcsLine leaves short lines untouched", () => {
    expect(foldIcsLine("SUMMARY:short")).toBe("SUMMARY:short");
  });

  it("toIcs renders a complete VCALENDAR with attendees and derived timestamps", () => {
    const out = toIcs(EVENT);
    expect(out.uid.endsWith("@uros")).toBe(true);
    expect(out.ics).toContain("BEGIN:VCALENDAR");
    expect(out.ics).toContain("VERSION:2.0");
    expect(out.ics).toContain("METHOD:REQUEST");
    expect(out.ics).toContain(`DTSTART:20261005T100000Z`);
    expect(out.ics).toContain(`DTEND:20261005T110000Z`);
    expect(out.ics).toContain("LOCATION:Dhaka HQ / Room 4");
    expect(out.ics).toContain("ATTENDEE;ROLE=REQ-PARTICIPANT:mailto:nusrat@example.com");
    expect(out.ics).toContain("END:VCALENDAR");
  });

  it("adapter send returns SENT with the rendered ICS payload", async () => {
    const res = await icalAdapter.send(EVENT, cfg(null));
    expect(res.status).toBe("SENT");
    expect((res as any).data.ics).toContain("BEGIN:VCALENDAR");
  });
});

describe("LinkedIn adapter", () => {
  let mock: HttpProviderMock;

  beforeAll(async () => {
    mock = new HttpProviderMock();
    await mock.start();
  });
  afterAll(async () => mock.stop());

  it("fetches the profile by id (URL-encoded) → DELIVERED", async () => {
    mock.setRoutes([{
      path: "/v2/people/abc%20def",
      status: 200,
      body: JSON.stringify({
        profile_id: "abc def",
        full_name: "Rafiq Islam",
        headline: "Backend engineer",
        experience: [{ organization: "ACME", designation: "SWE" }],
        education: [{ institution: "BUET" }],
      }),
    }]);
    const res = await linkedinAdapter.send({ profile_id: "abc def" }, cfg(mock.baseUrl()));
    expect(res.status).toBe("DELIVERED");
    expect((res as any).data.full_name).toBe("Rafiq Islam");
    expect(mock.lastRequest().headers.authorization).toBe("Bearer key-12345678");
  });

  it("403 → FAILED LINKEDIN_HTTP_403; healthCheck probes /v2/me", async () => {
    mock.setRoutes([{ path: "/v2/people/x", status: 403, body: "denied" }]);
    expect(await linkedinAdapter.send({ profile_id: "x" }, cfg(mock.baseUrl())))
      .toMatchObject({ status: "FAILED", error_code: "LINKEDIN_HTTP_403" });

    mock.setRoutes([{ path: "/v2/me", status: 200, body: "{}" }]);
    expect(await linkedinAdapter.healthCheck(cfg(mock.baseUrl()))).toBe(true);
  });
});

describe("interface-only adapters (Rule 18 exception)", () => {
  it.each([
    ["free_framework", freeFrameworkAdapter],
    ["telegram", telegramAdapter],
    ["viber", viberAdapter],
    ["signal", signalAdapter],
  ])("%s.send throws ProviderNotImplementedError — loud, never silent", async (_name, adapter) => {
    await expect(adapter.send({ to: "+8801", message: "x" }, cfg(null))).rejects.toBeInstanceOf(ProviderNotImplementedError);
    await expect(adapter.healthCheck(cfg(null))).rejects.toBeInstanceOf(ProviderNotImplementedError);
  });

  it.each(["telegram", "viber", "signal"])("%s's adapter name is stable for dispatcher error mapping", (name) => {
    const registry: Record<string, typeof telegramAdapter> = { telegram: telegramAdapter, viber: viberAdapter, signal: signalAdapter };
    expect(registry[name]!.name).toBe(name);
  });

  it("each interface-only family directory ships a README declaring the contract", () => {
    const base = path.resolve(__dirname, "../../../src/services/integrations");
    for (const dir of ["free_framework", "messaging"]) {
      const readme = path.join(base, dir, "README.md");
      expect(fs.existsSync(readme)).toBe(true);
      expect(fs.readFileSync(readme, "utf8")).toContain("ProviderNotImplementedError");
    }
  });
});
