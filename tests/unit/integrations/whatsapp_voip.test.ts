/**
 * Quest 04 — WhatsApp Cloud API and VOIP adapter wire contracts.
 */
import { HttpProviderMock } from "../../mocks/http_provider_mock";
import { HttpProviderConfig, MissingBaseUrlError } from "../../../src/services/integrations/sms/shared";
import { metaCloudApiAdapter } from "../../../src/services/integrations/whatsapp/meta_cloud_api";
import { voipAdapter } from "../../../src/services/integrations/voip/voip";

function cfg(baseUrl: string | null, apiKey = "wa-token-12345678"): HttpProviderConfig {
  return { apiKey, baseUrl, orgId: "org-test" };
}

const WA_INPUT = {
  phone_number_id: "PNID-1",
  to: "+8801712345678",
  template_name: "interview_invite",
  template_params: { candidate_name: "Nusrat", time: "Sunday 10am" },
  language: "bn",
};

describe("WhatsApp Meta Cloud API adapter", () => {
  let mock: HttpProviderMock;

  beforeAll(async () => {
    mock = new HttpProviderMock();
    await mock.start();
    mock.setRoutes([
      { path: "/PNID-1/messages", status: 200, body: JSON.stringify({ messages: [{ id: "wamid.ABC123" }] }) },
      { path: "/me", status: 200, body: JSON.stringify({ id: "PNID-1" }) },
    ]);
  });
  afterAll(async () => mock.stop());

  it("POSTs the template message with named body parameters → SENT with wamid", async () => {
    const res = await metaCloudApiAdapter.send(WA_INPUT, cfg(mock.baseUrl()));
    expect(res.status).toBe("SENT");
    expect((res as any).provider_id).toBe("wamid.ABC123");
    expect((res as any).data).toEqual({ provider_message_id: "wamid.ABC123" });

    const req = mock.lastRequest();
    expect(req.path).toBe("/PNID-1/messages");
    expect(req.headers.authorization).toBe("Bearer wa-token-12345678");
    expect(req.json).toMatchObject({
      messaging_product: "whatsapp",
      to: WA_INPUT.to,
      type: "template",
      template: {
        name: "interview_invite",
        language: { code: "bn" },
        components: [
          {
            type: "body",
            parameters: [
              { type: "text", text: "Nusrat", parameter_name: "candidate_name" },
              { type: "text", text: "Sunday 10am", parameter_name: "time" },
            ],
          },
        ],
      },
    });
  });

  it("missing phone_number_id is a definitive FAILED result", async () => {
    const res = await metaCloudApiAdapter.send({ ...WA_INPUT, phone_number_id: "" }, cfg(mock.baseUrl()));
    expect(res).toMatchObject({ status: "FAILED", error_code: "MISSING_PHONE_NUMBER_ID" });
  });

  it("4xx → FAILED WHATSAPP_HTTP_<status>", async () => {
    mock.setRoutes([{ path: "/PNID-1/messages", status: 470, body: "auth" }]);
    const res = await metaCloudApiAdapter.send(WA_INPUT, cfg(mock.baseUrl()));
    expect(res).toMatchObject({ status: "FAILED", error_code: "WHATSAPP_HTTP_470" });
  });

  it("healthCheck probes GET /me with the token", async () => {
    mock.setRoutes([{ path: "/me", status: 200, body: JSON.stringify({ id: "PNID-1" }) }]);
    expect(await metaCloudApiAdapter.healthCheck(cfg(mock.baseUrl()))).toBe(true);
    expect(mock.lastRequest().path).toBe("/me");
  });
});

describe("VOIP adapter", () => {
  let mock: HttpProviderMock;

  beforeAll(async () => {
    mock = new HttpProviderMock();
    await mock.start();
    mock.setRoutes([
      { path: "/v1/calls", status: 200, body: JSON.stringify({ call_id: "CALL-9" }) },
      { path: "/v1/health", status: 200, body: "ok" },
    ]);
  });
  afterAll(async () => mock.stop());

  it("no canonical host — missing baseUrl throws MissingBaseUrlError", async () => {
    await expect(voipAdapter.send({ to: "+8801", message: "reminder" }, cfg(null))).rejects.toBeInstanceOf(MissingBaseUrlError);
  });

  it("POSTs /v1/calls with Bearer auth → SENT with call_id", async () => {
    const res = await voipAdapter.send({ to: "+8801712345678", message: "Interview reminder", caller_id: "+8802" }, cfg(mock.baseUrl()));
    expect(res.status).toBe("SENT");
    expect((res as any).provider_id).toBe("CALL-9");
    expect(mock.lastRequest().json).toEqual({ to: "+8801712345678", message: "Interview reminder", caller_id: "+8802" });
  });

  it("4xx → FAILED VOIP_HTTP_<status>; response without call id → MALFORMED", async () => {
    mock.setRoutes([{ path: "/v1/calls", status: 402, body: "no balance" }]);
    expect(await voipAdapter.send({ to: "+8801", message: "m" }, cfg(mock.baseUrl())))
      .toMatchObject({ status: "FAILED", error_code: "VOIP_HTTP_402" });

    mock.setRoutes([{ path: "/v1/calls", status: 200, body: JSON.stringify({ ok: true }) }]);
    expect(await voipAdapter.send({ to: "+8801", message: "m" }, cfg(mock.baseUrl())))
      .toMatchObject({ status: "FAILED", error_code: "MALFORMED_PROVIDER_RESPONSE" });
  });

  it("healthCheck probes /v1/health", async () => {
    expect(await voipAdapter.healthCheck(cfg(mock.baseUrl()))).toBe(true);
    expect(mock.lastRequest().path).toBe("/v1/health");
  });
});
