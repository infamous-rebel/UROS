/**
 * Quest 04 — SMS adapter wire-contract tests.
 *
 * Every SMS provider adapter is exercised against the local HTTP mock via
 * its BYOK `base_url` — proving the request contract (auth placement,
 * body shape, provider-specific fields) and the uniform transport
 * behaviour: 2xx → SENT with provider id, 4xx → FAILED (definitive, no
 * throw), 5xx/network → THROWS (transient, retried by the dispatcher),
 * malformed success payload → FAILED MALFORMED_PROVIDER_RESPONSE.
 */
import { HttpProviderMock } from "../../mocks/http_provider_mock";
import { HttpProviderConfig } from "../../../src/services/integrations/sms/shared";
import { parseJsonIdField } from "../../../src/services/integrations/sms/shared";
import { MissingBaseUrlError } from "../../../src/services/integrations/sms/shared";
import { teletalkAdapter } from "../../../src/services/integrations/sms/teletalk";
import { grameenphoneAdapter } from "../../../src/services/integrations/sms/grameenphone";
import { banglalinkAdapter } from "../../../src/services/integrations/sms/banglalink";
import { robiAdapter } from "../../../src/services/integrations/sms/robi";
import { airtelAdapter } from "../../../src/services/integrations/sms/airtel";
import { sslWirelessAdapter } from "../../../src/services/integrations/sms/ssl_wireless";
import { alphaSmsAdapter } from "../../../src/services/integrations/sms/alpha_sms";
import { bulkSmsBdAdapter } from "../../../src/services/integrations/sms/bulk_sms_bd";
import { genericHttpAdapter } from "../../../src/services/integrations/sms/generic_http";

function cfg(baseUrl: string | null, apiKey = "test-api-key-12345"): HttpProviderConfig {
  return { apiKey, baseUrl, orgId: "org-test" };
}

const INPUT = { to: "+8801712345678", message: "Interview on Sunday 10am" };

describe("SMS adapters against the provider mock", () => {
  let mock: HttpProviderMock;
  let base: string;

  beforeAll(async () => {
    mock = new HttpProviderMock();
    base = await mock.start();
  });

  afterAll(async () => {
    await mock.stop();
  });

  beforeEach(() => {
    mock.resetRequests();
    mock.setRoutes([
      { path: "/api/v1/send", status: 200, body: JSON.stringify({ message_id: "TL-1001" }) },       // teletalk
      { path: "/sms/send", status: 200, body: JSON.stringify({ messageId: "GP-2002" }) },            // grameenphone
      { path: "/v1/messages", status: 200, body: JSON.stringify({ id: "BL-3003" }) },                // banglalink
      { path: "/api/sms/send", status: 200, body: JSON.stringify({ sms_id: "RB-4004" }) },           // robi
      { path: "/v1/sms", status: 200, body: JSON.stringify({ transactionId: "AR-5005" }) },          // airtel
      { path: "/api/v3/sendSMS", status: 200, body: "SMS SUBMITTED:SSL-6006" },                      // ssl_wireless
      { path: "/sendsms", status: 200, body: JSON.stringify({ error: 0, msg_id: 7007 }) },           // alpha_sms (numeric id)
      { path: "/api/send", status: 200, body: JSON.stringify({ message_id: "BS-8008" }) },           // bulk_sms_bd
      { path: "/send", status: 200, body: JSON.stringify({ id: "GH-9009" }) },                       // generic_http
    ]);
  });

  // ─── Request-contract assertions per provider ────────────────────────
  it("teletalk: Bearer JSON POST {to, message, sender_id} → SENT with message_id", async () => {
    const res = await teletalkAdapter.send({ ...INPUT, sender_id: "UROS" }, cfg(base));
    expect(res.status).toBe("SENT");
    expect((res as any).data).toEqual({ provider_message_id: "TL-1001" });

    const req = mock.lastRequest();
    expect(req.path).toBe("/api/v1/send");
    expect(req.headers.authorization).toBe("Bearer test-api-key-12345");
    expect(req.json).toEqual({ to: INPUT.to, message: INPUT.message, sender_id: "UROS" });
  });

  it("grameenphone: POST /sms/send with {msisdn, text, sender} → SENT", async () => {
    const res = await grameenphoneAdapter.send({ ...INPUT, sender_id: "UROS" }, cfg(base));
    expect(res.status).toBe("SENT");
    expect((res as any).data.provider_message_id).toBe("GP-2002");
    expect(mock.lastRequest().json).toEqual({ msisdn: INPUT.to, text: INPUT.message, sender: "UROS" });
  });

  it("banglalink: POST /v1/messages with {msisdn, message} → SENT", async () => {
    const res = await banglalinkAdapter.send(INPUT, cfg(base));
    expect(res.status).toBe("SENT");
    expect((res as any).data.provider_message_id).toBe("BL-3003");
    expect(mock.lastRequest().json).toEqual({ msisdn: INPUT.to, message: INPUT.message });
  });

  it("robi: POST /api/sms/send with {msisdn, message, senderId} → SENT", async () => {
    const res = await robiAdapter.send({ ...INPUT, sender_id: "UROS" }, cfg(base));
    expect(res.status).toBe("SENT");
    expect((res as any).data.provider_message_id).toBe("RB-4004");
    expect(mock.lastRequest().json).toEqual({ msisdn: INPUT.to, message: INPUT.message, senderId: "UROS" });
  });

  it("airtel: POST /v1/sms with {msisdn, message} → SENT", async () => {
    const res = await airtelAdapter.send(INPUT, cfg(base));
    expect(res.status).toBe("SENT");
    expect((res as any).data.provider_message_id).toBe("AR-5005");
  });

  it("ssl_wireless: form POST token/msisdn/message/csms_id → parses 'SMS SUBMITTED:<id>'", async () => {
    const res = await sslWirelessAdapter.send(INPUT, cfg(base));
    expect(res.status).toBe("SENT");
    expect((res as any).data.provider_message_id).toBe("SSL-6006");

    const req = mock.lastRequest();
    expect(req.headers["content-type"]).toContain("application/x-www-form-urlencoded");
    expect(req.form!.get("token")).toBe("test-api-key-12345");
    expect(req.form!.get("msisdn")).toBe(INPUT.to);
    expect(req.form!.get("message")).toBe(INPUT.message);
    // csms_id is a deterministic de-dup id: same input → same id.
    const first = req.form!.get("csms_id");
    await sslWirelessAdapter.send(INPUT, cfg(base));
    expect(mock.lastRequest().form!.get("csms_id")).toBe(first);
  });

  it("alpha_sms: query-param contract → parses {error:0, msg_id} (numeric id coerced)", async () => {
    const res = await alphaSmsAdapter.send(INPUT, cfg(base));
    expect(res.status).toBe("SENT");
    expect((res as any).data.provider_message_id).toBe("7007");

    const req = mock.lastRequest();
    expect(req.query.get("api_key")).toBe("test-api-key-12345");
    expect(req.query.get("to")).toBe(INPUT.to);
    expect(req.query.get("msg")).toBe(INPUT.message);
  });

  it("bulk_sms_bd: X-Api-Key header contract → SENT", async () => {
    const res = await bulkSmsBdAdapter.send(INPUT, cfg(base));
    expect(res.status).toBe("SENT");
    expect((res as any).data.provider_message_id).toBe("BS-8008");
    expect(mock.lastRequest().headers["x-api-key"]).toBe("test-api-key-12345");
  });

  it("generic_http: POST /send with Bearer when key present → SENT", async () => {
    const res = await genericHttpAdapter.send(INPUT, cfg(base));
    expect(res.status).toBe("SENT");
    expect((res as any).data.provider_message_id).toBe("GH-9009");
    expect(mock.lastRequest().json).toEqual({ to: INPUT.to, message: INPUT.message, sender_id: undefined });
  });

  // ─── Uniform transport behaviour ─────────────────────────────────────
  it("4xx is a definitive FAILED result (HTTP_<status>), never a throw", async () => {
    mock.setRoutes([{ path: "/api/v1/send", status: 400, body: JSON.stringify({ error: "invalid msisdn" }) }]);
    const res = await teletalkAdapter.send(INPUT, cfg(base));
    expect(res.status).toBe("FAILED");
    expect((res as any).error_code).toBe("HTTP_400");
    expect((res as any).error_message).toContain("invalid msisdn");
  });

  it("5xx THROWS (transient — the dispatcher's retry layer owns it)", async () => {
    mock.setRoutes([{ path: "/api/v1/send", status: 503, body: "upstream busy" }]);
    await expect(teletalkAdapter.send(INPUT, cfg(base))).rejects.toThrow();
  });

  it("network failure THROWS (transient)", async () => {
    // Port 1 on localhost: nothing listens — immediate connection refusal.
    await expect(teletalkAdapter.send(INPUT, cfg("http://127.0.0.1:1"))).rejects.toThrow();
  });

  it("2xx with a malformed success payload → FAILED MALFORMED_PROVIDER_RESPONSE", async () => {
    mock.setRoutes([{ path: "/api/v1/send", status: 200, body: JSON.stringify({ unexpected: true }) }]);
    const res = await teletalkAdapter.send(INPUT, cfg(base));
    expect(res.status).toBe("FAILED");
    expect((res as any).error_code).toBe("MALFORMED_PROVIDER_RESPONSE");
  });

  it("healthCheck probes the send URL's origin (GET /): 2xx/4xx (<500) → true, 5xx/network → false", async () => {
    mock.setRoutes([{ path: "/", status: 200, body: "{}" }]);
    expect(await teletalkAdapter.healthCheck(cfg(base))).toBe(true);

    mock.setRoutes([{ path: "/", status: 401, body: "denied" }]);
    expect(await teletalkAdapter.healthCheck(cfg(base))).toBe(true);

    mock.setRoutes([{ path: "/", status: 500, body: "boom" }]);
    expect(await teletalkAdapter.healthCheck(cfg(base))).toBe(false);
    expect(await teletalkAdapter.healthCheck(cfg("http://127.0.0.1:1"))).toBe(false);
  });

  // ─── Credential-contract behaviour ───────────────────────────────────
  it.each([
    ["grameenphone", grameenphoneAdapter],
    ["banglalink", banglalinkAdapter],
    ["robi", robiAdapter],
    ["airtel", airtelAdapter],
    ["ssl_wireless", sslWirelessAdapter],
    ["bulk_sms_bd", bulkSmsBdAdapter],
    ["generic_http", genericHttpAdapter],
  ])("%s has no canonical host — missing baseUrl is a malformed credential (throws)", async (_name, adapter) => {
    await expect(adapter.send(INPUT, cfg(null))).rejects.toBeInstanceOf(MissingBaseUrlError);
  });

  it("teletalk has a canonical host — null baseUrl is NOT a credential error (network error instead)", async () => {
    // Unroutable loopback: proves no MissingBaseUrlError without touching
    // the real sms.teletalk.com.bd host (unit tests never leave the machine).
    await expect(teletalkAdapter.send(INPUT, cfg("http://127.0.0.1:1")))
      .rejects.not.toBeInstanceOf(MissingBaseUrlError);
  });
});

describe("parseJsonIdField", () => {
  it.each([
    ["message_id", "abc"],
    ["messageId", "def"],
    ["msg_id", "ghi"],
    ["id", "jkl"],
    ["sms_id", "mno"],
    ["transactionId", "pqr"],
  ])("extracts supported id field %s", (field, value) => {
    expect(parseJsonIdField(JSON.stringify({ [field]: value }))).toEqual({ provider_message_id: value });
  });

  it("coerces numeric ids to string", () => {
    expect(parseJsonIdField(JSON.stringify({ msg_id: 42 }))).toEqual({ provider_message_id: "42" });
  });

  it("throws when no known id field is present", () => {
    expect(() => parseJsonIdField(JSON.stringify({ status: "ok" }))).toThrow(/missing message id/);
  });

  it("throws on non-JSON bodies", () => {
    expect(() => parseJsonIdField("not json")).toThrow();
  });
});
