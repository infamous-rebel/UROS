/**
 * Quest 04 — bdjobs and Teletalk adapter tests.
 *
 * path_a (session scraper), path_d (ATS webhook), teletalk_sms and
 * teletalk cv_bank run against the HTTP mock; path_b is a pure CSV
 * transformation; path_c delegates to the IMAP transport and is tested
 * for its credential failure modes (missing baseUrl throws; an
 * unreachable mailbox yields a structured FAILED result — real socket,
 * no listener, no mock needed).
 */
import { HttpProviderMock } from "../../mocks/http_provider_mock";
import { HttpProviderConfig, MissingBaseUrlError } from "../../../src/services/integrations/sms/shared";
import { bdjobsSessionScraperAdapter } from "../../../src/services/integrations/bdjobs/path_a_session_scraper";
import { bdjobsCsvImportAdapter, parseBdjobsCsv } from "../../../src/services/integrations/bdjobs/path_b_csv_import";
import { bdjobsEmailIntakeAdapter } from "../../../src/services/integrations/bdjobs/path_c_email_intake";
import { bdjobsAtsWebhookAdapter } from "../../../src/services/integrations/bdjobs/path_d_ats_webhook";
import { teletalkSmsAdapter } from "../../../src/services/integrations/teletalk/sms";
import { teletalkCvBankAdapter } from "../../../src/services/integrations/teletalk/cv_bank";

function cfg(baseUrl: string | null, apiKey = "key-12345678"): HttpProviderConfig {
  return { apiKey, baseUrl, orgId: "org-test" };
}

describe("bdjobs path_a — session scraper", () => {
  let mock: HttpProviderMock;

  beforeAll(async () => {
    mock = new HttpProviderMock();
    await mock.start();
  });
  afterAll(async () => mock.stop());

  it("searches the resume bank with keyword query params → DELIVERED with candidates", async () => {
    mock.setRoutes([{
      path: "/v1/resume-bank/search",
      status: 200,
      body: JSON.stringify({ candidates: [{ candidate_id: "BJ-1", full_name: "Rafiq Islam", resume_url: "https://cv/1", keywords_matched: ["node"] }] }),
    }]);
    const res = await bdjobsSessionScraperAdapter.send(
      { job_posting_id: "JP-9", keywords: ["node", "react"], min_experience_years: 2 },
      cfg(mock.baseUrl())
    );
    expect(res.status).toBe("DELIVERED");
    expect((res as any).data).toHaveLength(1);

    const req = mock.lastRequest();
    expect(req.path).toBe("/v1/resume-bank/search");
    expect(req.query.get("job_posting_id")).toBe("JP-9");
    expect(req.query.get("keywords")).toBe("node,react");
    expect(req.query.get("min_experience_years")).toBe("2");
  });

  it("missing baseUrl throws MissingBaseUrlError; 5xx → FAILED BDJOBS_HTTP_<status>", async () => {
    await expect(bdjobsSessionScraperAdapter.send({ job_posting_id: "JP", keywords: [] }, cfg(null)))
      .rejects.toBeInstanceOf(MissingBaseUrlError);

    mock.setRoutes([{ path: "/v1/resume-bank/search", status: 502, body: "bad gateway" }]);
    expect(await bdjobsSessionScraperAdapter.send({ job_posting_id: "JP", keywords: [] }, cfg(mock.baseUrl())))
      .toMatchObject({ status: "FAILED", error_code: "BDJOBS_HTTP_502" });
  });
});

describe("bdjobs path_b — CSV import (pure transformation)", () => {
  const CSV = [
    "candidate_id,full_name,email,phone_primary,resume_url,keywords",
    "BJ-1,Rafiq Islam,rafiq@x.com,+88017,https://cv/1,node|react",
    "BJ-2,Sara Akter,,+88018,https://cv/2,python",
  ].join("\n");

  it("parseBdjobsCsv maps rows onto BdjobsResume records", () => {
    const rows = parseBdjobsCsv(CSV);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({
      candidate_id: "BJ-1",
      full_name: "Rafiq Islam",
      email: "rafiq@x.com",
      phone_primary: "+88017",
      resume_url: "https://cv/1",
      keywords_matched: ["node", "react"],
    });
    expect(rows[1].email).toBeUndefined();
  });

  it("adapter: valid CSV → DELIVERED; empty → CSV_EMPTY; invalid rows → CSV_INVALID_ROWS", async () => {
    expect(await bdjobsCsvImportAdapter.send({ csv_text: CSV }, cfg(null))).toMatchObject({ status: "DELIVERED" });

    expect(await bdjobsCsvImportAdapter.send({ csv_text: "candidate_id,full_name\n" }, cfg(null)))
      .toMatchObject({ status: "FAILED", error_code: "CSV_EMPTY" });

    const bad = "candidate_id,full_name,resume_url\n,Missing Name,https://cv/x";
    expect(await bdjobsCsvImportAdapter.send({ csv_text: bad }, cfg(null)))
      .toMatchObject({ status: "FAILED", error_code: "CSV_INVALID_ROWS" });
  });
});

describe("bdjobs path_c — email intake (IMAP delegation)", () => {
  it("missing baseUrl throws the IMAP credential error before any transport", async () => {
    await expect(bdjobsEmailIntakeAdapter.send({ mailbox: "INBOX" }, cfg(null))).rejects.toThrow(/base_url is required/);
  });

  it("unreachable mailbox → structured FAILED result (real refused socket)", async () => {
    const res = await bdjobsEmailIntakeAdapter.send({ mailbox: "INBOX" }, { apiKey: "user:pass", baseUrl: "imap://127.0.0.1:1", orgId: "org-test" });
    expect(res.status).toBe("FAILED");
    expect((res as any).error_message).toBeTruthy();
  });
});

describe("bdjobs path_d — ATS webhook", () => {
  let mock: HttpProviderMock;

  beforeAll(async () => {
    mock = new HttpProviderMock();
    await mock.start();
    mock.setRoutes([{ path: "/candidates", status: 200, body: JSON.stringify({ ok: true }) }]);
  });
  afterAll(async () => mock.stop());

  it("pushes the candidate payload with the event id → SENT accepted:true", async () => {
    const input = {
      event_id: "EVT-1",
      event_type: "candidate_shortlisted" as const,
      candidate: { candidate_id: "CAND-1", full_name: "Rafiq Islam", score: 82 },
    };
    const res = await bdjobsAtsWebhookAdapter.send(input, cfg(mock.baseUrl()));
    expect(res.status).toBe("SENT");
    expect((res as any).data).toEqual({ accepted: true });
    expect(mock.lastRequest().json).toEqual(input);
  });

  it("missing baseUrl throws MissingBaseUrlError", async () => {
    await expect(
      bdjobsAtsWebhookAdapter.send({ event_id: "E", event_type: "candidate_rejected", candidate: { candidate_id: "C", full_name: "X" } }, cfg(null))
    ).rejects.toBeInstanceOf(MissingBaseUrlError);
  });
});

describe("teletalk top-level adapters", () => {
  let mock: HttpProviderMock;

  beforeAll(async () => {
    mock = new HttpProviderMock();
    await mock.start();
    mock.setRoutes([
      { path: "/api/v1/send", status: 200, body: JSON.stringify({ message_id: "TT-SMS-1" }) },
      { path: "/v1/circulars/CIRC-77/applications", status: 200, body: JSON.stringify({ applications: [{ application_id: "APP-1", full_name: "Nusrat" }] }) },
    ]);
  });
  afterAll(async () => mock.stop());

  it("teletalk_sms posts the JSON contract → SENT", async () => {
    const res = await teletalkSmsAdapter.send({ to: "+880155", message: "msg" }, cfg(mock.baseUrl()));
    expect(res.status).toBe("SENT");
    expect((res as any).data.provider_message_id).toBe("TT-SMS-1");
  });

  it("cv_bank fetches structured applications for a circular → DELIVERED", async () => {
    const res = await teletalkCvBankAdapter.send({ circular_id: "CIRC-77" }, cfg(mock.baseUrl()));
    expect(res.status).toBe("DELIVERED");
    expect((res as any).data.applications).toHaveLength(1);
  });

  it("cv_bank requires baseUrl", async () => {
    await expect(teletalkCvBankAdapter.send({ circular_id: "C" }, cfg(null))).rejects.toBeInstanceOf(MissingBaseUrlError);
  });
});
