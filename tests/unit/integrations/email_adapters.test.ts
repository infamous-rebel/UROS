/**
 * Quest 04 — Email adapter tests.
 *
 * - gmail_api / microsoft_graph / sendgrid: wire contracts against the
 *   local HTTP mock (base_url from BYOK).
 * - amazon_ses: the host is regex-locked to *.amazonaws.com so it cannot
 *   be pointed at a mock — its signature construction is instead verified
 *   deterministically (SigV4 structure + independent payload hash), and
 *   the credential parser's failure modes are exercised.
 * - smtp_outbound: real SMTP wire test over loopback using the dev-only
 *   `smtp-server` test double (production code never imports it).
 * - imap config parsing and its failure modes.
 */
import * as crypto from "crypto";
import { SMTPServer } from "smtp-server"; // devDependency: test-only SMTP loopback (production never imports it)
import { HttpProviderMock } from "../../mocks/http_provider_mock";
import { HttpProviderConfig } from "../../../src/services/integrations/sms/shared";
import { EmailInput } from "../../../src/services/integrations/_base/types";

import { gmailApiAdapter, buildMimeText, toBase64Url } from "../../../src/services/integrations/email/gmail_api";
import { microsoftGraphAdapter, toGraphMessage } from "../../../src/services/integrations/email/microsoft_graph";
import { sendgridAdapter, toSendGridBody } from "../../../src/services/integrations/email/sendgrid";
import { amazonSesAdapter, parseSesConfig, signAwsRequest } from "../../../src/services/integrations/email/amazon_ses";
import { smtpOutboundAdapter, parseSmtpConfig, toNodemailerMessage } from "../../../src/services/integrations/email/smtp_outbound";
import { parseImapConfig } from "../../../src/services/integrations/email/imap_inbound";

function cfg(baseUrl: string | null, apiKey = "test-api-key-12345"): HttpProviderConfig {
  return { apiKey, baseUrl, orgId: "org-test" };
}

const MAIL: EmailInput = {
  to: "candidate@example.com",
  from: "recruiter@uros.test",
  subject: "Interview schedule",
  body_text: "Your interview is on Sunday.",
  body_html: "<p>Your interview is on Sunday.</p>",
};

describe("Gmail API adapter", () => {
  let mock: HttpProviderMock;

  beforeAll(async () => {
    mock = new HttpProviderMock();
    await mock.start();
    mock.setRoutes([
      { path: "/gmail/v1/users/me/messages/send", status: 200, body: JSON.stringify({ id: "gmsg-1" }) },
      { path: "/gmail/v1/users/me/profile", status: 200, body: JSON.stringify({}) },
    ]);
  });
  afterAll(async () => mock.stop());

  it("sends base64url raw MIME with Bearer token → SENT with the Gmail id", async () => {
    const res = await gmailApiAdapter.send(MAIL, cfg(mock.baseUrl()));
    expect(res.status).toBe("SENT");
    expect((res as any).data.provider_message_id).toBe("gmsg-1");

    const req = mock.lastRequest();
    expect(req.headers.authorization).toBe("Bearer test-api-key-12345");
    // Gmail contract: JSON body { raw: <base64url RFC 5322 message> }.
    const raw = Buffer.from((req.json as any).raw as string, "base64").toString("utf8");
    expect(raw).toContain("To: candidate@example.com");
    expect(raw).toContain("From: recruiter@uros.test");
    expect(raw).toContain("Subject: Interview schedule");
    expect(raw).toContain("multipart/alternative");
    expect(raw).toContain("text/html");
  });

  it("4xx → FAILED GRAPH-style HTTP error code (definitive)", async () => {
    mock.setRoutes([{ path: "/gmail/v1/users/me/messages/send", status: 403, body: "denied" }]);
    const res = await gmailApiAdapter.send(MAIL, cfg(mock.baseUrl()));
    expect(res.status).toBe("FAILED");
  });
});

describe("MIME builder", () => {
  it("plain text only → simple RFC 5322 message", () => {
    const mime = buildMimeText({ ...MAIL, body_html: undefined });
    expect(mime).toContain("Content-Type: text/plain");
    expect(mime).not.toContain("multipart/alternative");
    expect(mime.endsWith("Your interview is on Sunday.\r\n")).toBe(true);
  });

  it("toBase64Url strips padding and avoids +/", () => {
    expect(toBase64Url("subjects?>+")).not.toMatch(/[+/=]/);
    expect(Buffer.from(toBase64Url("hello world").padEnd(Math.ceil(toBase64Url("hello world").length / 4) * 4, "=").replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8")).toBe("hello world");
  });
});

describe("Microsoft Graph adapter", () => {
  let mock: HttpProviderMock;

  beforeAll(async () => {
    mock = new HttpProviderMock();
    await mock.start();
    mock.setRoutes([
      { path: "/v1.0/me/sendMail", status: 202, body: "" },
      { path: "/v1.0/me", status: 200, body: "{}" },
    ]);
  });
  afterAll(async () => mock.stop());

  it("202 Accepted → SENT with a synthetic correlation id", async () => {
    const res = await microsoftGraphAdapter.send(MAIL, cfg(mock.baseUrl()));
    expect(res.status).toBe("SENT");
    const id = (res as any).data.provider_message_id as string;
    expect(id).toHaveLength(32);
    expect(mock.lastRequest().json).toMatchObject({
      message: {
        subject: "Interview schedule",
        body: { contentType: "HTML", content: "<p>Your interview is on Sunday.</p>" },
        toRecipients: [{ emailAddress: { address: "candidate@example.com" } }],
      },
      saveToSentItems: true,
    });
  });

  it("toGraphMessage maps attachments to fileAttachment resources", () => {
    const msg = toGraphMessage({
      ...MAIL,
      attachments: [{ filename: "cv.pdf", content_type: "application/pdf", data: Buffer.from("pdf") }],
    }) as any;
    expect(msg.message.attachments[0]).toMatchObject({
      "@odata.type": "#microsoft.graph.fileAttachment",
      name: "cv.pdf",
      contentBytes: Buffer.from("pdf").toString("base64"),
    });
  });

  it("4xx → FAILED GRAPH_HTTP_<status>", async () => {
    mock.setRoutes([{ path: "/v1.0/me/sendMail", status: 401, body: "unauthorized" }]);
    const res = await microsoftGraphAdapter.send(MAIL, cfg(mock.baseUrl()));
    expect(res).toMatchObject({ status: "FAILED", error_code: "GRAPH_HTTP_401" });
  });
});

describe("SendGrid adapter", () => {
  let mock: HttpProviderMock;

  beforeAll(async () => {
    mock = new HttpProviderMock();
    await mock.start();
  });
  afterAll(async () => mock.stop());

  it("echoed x-message-id header becomes the provider id", async () => {
    mock.setRoutes([{ path: "/v3/mail/send", status: 202, body: "", headers: { "x-message-id": "sg-echo-1" } }]);
    const res = await sendgridAdapter.send(MAIL, cfg(mock.baseUrl()));
    expect(res.status).toBe("SENT");
    expect((res as any).data.provider_message_id).toBe("sg-echo-1");
    expect(mock.lastRequest().json).toEqual(toSendGridBody(MAIL));
  });

  it("4xx → FAILED SENDGRID_HTTP_<status>", async () => {
    mock.setRoutes([{ path: "/v3/mail/send", status: 400, body: "bad" }]);
    const res = await sendgridAdapter.send(MAIL, cfg(mock.baseUrl()));
    expect(res).toMatchObject({ status: "FAILED", error_code: "SENDGRID_HTTP_400" });
  });
});

describe("Amazon SES credential parser + SigV4 signing", () => {
  it("parses region from the email.<region>.amazonaws.com host", () => {
    const creds = parseSesConfig(cfg("https://email.ap-south-1.amazonaws.com", "AKID:SECRET"));
    expect(creds).toEqual({ accessKey: "AKID", secretKey: "SECRET", region: "ap-south-1", host: "email.ap-south-1.amazonaws.com" });
  });

  it.each([
    ["missing baseUrl", cfg(null)],
    ["non-SES host", cfg("https://example.com")],
    ["apiKey without colon separator", cfg("https://email.ap-south-1.amazonaws.com", "JUST_A_KEY")],
  ])("rejects malformed credentials: %s", (_label, config) => {
    expect(() => parseSesConfig(config)).toThrow(/malformed/);
  });

  it("signAwsRequest produces a structurally valid SigV4 authorization header", () => {
    const creds = { accessKey: "AKIDEXAMPLE", secretKey: "wJalrXUtnFEMI", region: "ap-south-1", host: "email.ap-south-1.amazonaws.com" };
    const body = JSON.stringify({ FromEmailAddress: "x@y.z" });
    const amzDate = "20260929T000000Z";
    const { authorization, payloadHash } = signAwsRequest("POST", "/v2/email/outbound-emails", body, creds, amzDate);

    // Independent payload hash (not read from the adapter).
    expect(payloadHash).toBe(crypto.createHash("sha256").update(body).digest("hex"));

    const match = authorization.match(
      /^AWS4-HMAC-SHA256 Credential=(.+?), SignedHeaders=([\w-;]+), Signature=([0-9a-f]{64})$/
    );
    expect(match).not.toBeNull();
    const [, credential, signedHeaders] = match!;
    expect(credential).toBe("AKIDEXAMPLE/20260929/ap-south-1/ses/aws4_request");
    expect(signedHeaders).toBe("content-type;host;x-amz-content-sha256;x-amz-date");
    // Signature must be deterministic for identical inputs.
    const again = signAwsRequest("POST", "/v2/email/outbound-emails", body, creds, amzDate);
    expect(again.authorization).toBe(authorization);
  });

  it("send() with a malformed credential throws before any network call", async () => {
    await expect(amazonSesAdapter.send(MAIL, cfg(null))).rejects.toThrow(/malformed/);
  });
});

describe("SMTP outbound adapter (real loopback socket)", () => {
  const captured: Array<{ from: string; to: string; data: string }> = [];
  let smtpServer: SMTPServer;
  let smtpPort = 0;

  beforeAll(async () => {
    // Dev-dependency test double (Rule 18: test infra lives in tests).
    smtpServer = new SMTPServer({
      authOptional: true,
      disabledCommands: ["STARTTLS"],
      // Accept LOGIN/PLAIN credentials — this also proves the BYOK
      // user:pass pair crossed the wire intact (auth.username === "mailer").
      onAuth: (auth: any, _session: any, cb: (err: Error | null, res?: { user: string }) => void) => {
        if (auth.username !== "mailer") {
          cb(new Error("unexpected credential user"));
          return;
        }
        cb(null, { user: auth.username });
      },
      onRcptTo: (_ctx: any, _session: any, cb: (err?: Error | null) => void) => cb(),
      onData: (stream: any, session: any, cb: (err?: Error) => void) => {
        const chunks: Buffer[] = [];
        stream.on("data", (c: Buffer) => chunks.push(c));
        stream.on("end", () => {
          // smtp-server exposes the envelope via session.envelope in 3.19.x.
          captured.push({
            from: (session.envelope.mailFrom && session.envelope.mailFrom.address) || "",
            to: (session.envelope.rcptTo && session.envelope.rcptTo[0] && session.envelope.rcptTo[0].address) || "",
            data: Buffer.concat(chunks).toString("utf8"),
          });
          cb();
        });
      },
    });
    await new Promise<void>((resolve) => smtpServer.listen(0, "127.0.0.1", resolve));
    smtpPort = (smtpServer as any).server.address().port;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => smtpServer.close(() => resolve()));
  });

  it("parseSmtpConfig parses smtp:// URLs and 'user:pass' apiKey", () => {
    const info = parseSmtpConfig(cfg(`smtp://127.0.0.1:${smtpPort}`, "mailer:secret-pass"));
    expect(info.host).toBe("127.0.0.1");
    expect(info.port).toBe(smtpPort);
    expect(info.secure).toBe(false);
    expect(info.user).toBe("mailer");
    expect(info.pass).toBe("secret-pass");
  });

  it("parseSmtpConfig rejects missing baseUrl and colon-less apiKey", () => {
    expect(() => parseSmtpConfig(cfg(null))).toThrow(/base_url is required/);
    expect(() => parseSmtpConfig(cfg(`smtp://127.0.0.1:${smtpPort}`, "NO_COLON"))).toThrow(/username:password/);
  });

  it("toNodemailerMessage maps the uniform input", () => {
    const msg = toNodemailerMessage(MAIL) as any;
    expect(msg.to).toBe("candidate@example.com");
    expect(msg.from).toBe("recruiter@uros.test");
    expect(msg.subject).toBe("Interview schedule");
    expect(msg.text).toContain("Sunday");
    expect(msg.html).toContain("Sunday");
  });

  it("delivers a real SMTP message over the loopback socket → SENT", async () => {
    captured.length = 0;
    const res = await smtpOutboundAdapter.send(MAIL, cfg(`smtp://127.0.0.1:${smtpPort}`, "mailer:secret-pass"));
    expect(res.status).toBe("SENT");
    expect(captured).toHaveLength(1);
    expect(captured[0].to).toBe("candidate@example.com");
    expect(captured[0].from).toBe("recruiter@uros.test");
    expect(captured[0].data).toContain("Subject: Interview schedule");
    expect(captured[0].data).toContain("Your interview is on Sunday.");
  });

  it("connection refused → THROWS (transient)", async () => {
    await expect(smtpOutboundAdapter.send(MAIL, cfg("smtp://127.0.0.1:1"))).rejects.toThrow();
  });
});

describe("IMAP credential parsing", () => {
  it("parses imaps/imap URLs with default ports and secure flag", () => {
    expect(parseImapConfig(cfg("imaps://imap.example.com", "user:pass"))).toEqual({
      host: "imap.example.com", port: 993, secure: true, user: "user", pass: "pass",
    });
    expect(parseImapConfig(cfg("imap://mx.local:1430", "u:p"))).toEqual({
      host: "mx.local", port: 1430, secure: false, user: "u", pass: "p",
    });
  });

  it.each([
    ["missing baseUrl", cfg(null)],
    ["invalid URL", cfg("not-a-url")],
    ["wrong protocol", cfg("https://imap.example.com")],
    ["apiKey without colon", cfg("imaps://imap.example.com", "ONLYUSER")],
  ])("rejects malformed credentials: %s", (_label, config) => {
    expect(() => parseImapConfig(config)).toThrow(/malformed/);
  });
});
