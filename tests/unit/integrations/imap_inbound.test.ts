/**
 * Quest 04 — IMAP inbound adapter lifecycle (injected-client tests).
 *
 * The adapter is created through `makeImapInboundAdapter(clientFactory)`;
 * tests inject an in-memory ImapClient so the full session lifecycle —
 * connect → mailbox lock → search unseen → fetch (with attachment
 * download) → release lock → logout — is verified without network.
 * Production registration still uses the real ImapFlow factory (Rule 18).
 */
import { makeImapInboundAdapter, ImapClient, ImapClientFactory, ImapMessage } from "../../../src/services/integrations/email/imap_inbound";
import { HttpProviderConfig } from "../../../src/services/integrations/sms/shared";
import type { MessageStructureObject } from "imapflow";

function cfg(): HttpProviderConfig {
  return { apiKey: "user:pass", baseUrl: "imaps://imap.test:993", orgId: "org-test" };
}

/** Deterministic in-memory ImapFlow stand-in. */
class FakeImapClient implements ImapClient {
  connected = false;
  lockAcquired = 0;
  lockReleased = 0;
  loggedOut = false;
  searched = 0;
  lastLimit: number | null = null;
  downloaded: string[] = [];

  constructor(
    private uids: number[] = [101, 102],
    private messages: Record<number, { envelope: any; structure: MessageStructureObject; parts: Record<string, Buffer> }> = {}
  ) {}

  async connect(): Promise<void> { this.connected = true; }
  async getMailboxLock(_mailbox: string): Promise<{ release(): Promise<void> }> {
    this.lockAcquired += 1;
    return { release: async () => { this.lockReleased += 1; } };
  }
  async searchUnseenUids(limit: number): Promise<number[]> {
    this.searched += 1;
    this.lastLimit = limit;
    return this.uids.slice(0, limit);
  }
  async fetchMessage(uid: number): Promise<ImapMessage> {
    const m = this.messages[uid] ?? {
      envelope: {},
      structure: { part: "1", type: "text/plain" } as MessageStructureObject,
      parts: { "1": Buffer.from("") },
    };
    const text: Buffer[] = [];
    const attachments: any[] = [];
    const leaves: MessageStructureObject[] = [];
    const collect = (n: MessageStructureObject) => {
      if (n.childNodes && n.childNodes.length) { n.childNodes.forEach(collect); return; }
      leaves.push(n);
    };
    collect(m.structure);
    for (const leaf of leaves) {
      const buf = m.parts[leaf.part!];
      if (leaf.disposition === "attachment" || !leaf.type.startsWith("text/")) {
        attachments.push({ filename: leaf.dispositionParameters?.filename ?? `attachment-${leaf.part}`, mime_type: leaf.type, buffer: buf });
      } else {
        text.push(buf);
      }
    }
    return {
      uid,
      message_id: m.envelope.messageId,
      from: m.envelope.from?.[0]?.address ?? "",
      subject: m.envelope.subject ?? "",
      received_at: m.envelope.date ?? new Date().toISOString(),
      body_text: Buffer.concat(text).toString("utf8"),
      attachments,
    };
  }
  async logout(): Promise<void> { this.loggedOut = true; }
}

function multipartFixtures() {
  const text = Buffer.from("Please find my CV attached.");
  const pdf = Buffer.from("%PDF-1.4 fake");
  const structure: MessageStructureObject = {
    type: "multipart/mixed",
    childNodes: [
      { part: "1", type: "text/plain" },
      { part: "2", type: "application/pdf", disposition: "attachment", dispositionParameters: { filename: "cv.pdf" } },
    ],
  };
  return { structure, parts: { "1": text, "2": pdf }, text, pdf };
}

describe("imap_inbound adapter (injected fake client)", () => {
  it("fetches unseen messages end-to-end: connect → lock → search → fetch → release → logout", async () => {
    const { structure, parts, text, pdf } = multipartFixtures();
    const client = new FakeImapClient([101], {
      101: { envelope: { messageId: "<m1@test>", from: [{ address: "applicant@example.com" }], subject: "Application", date: "2026-09-01T10:00:00Z" }, structure, parts },
    });
    const factory: ImapClientFactory = () => client;
    const adapter = makeImapInboundAdapter(factory);

    const res = await adapter.send({ mailbox: "INBOX", limit: 5 }, cfg());

    expect(res.status).toBe("DELIVERED");
    expect(client.connected).toBe(true);
    expect(client.lockAcquired).toBe(1);
    expect(client.lockReleased).toBe(1);
    expect(client.loggedOut).toBe(true);
    const messages = (res as any).data as ImapMessage[];
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      uid: 101,
      message_id: "<m1@test>",
      from: "applicant@example.com",
      subject: "Application",
      body_text: "Please find my CV attached.",
    });
    expect(messages[0].attachments).toHaveLength(1);
    expect(messages[0].attachments[0]).toMatchObject({ filename: "cv.pdf", mime_type: "application/pdf" });
    expect(messages[0].attachments[0].buffer.equals(pdf)).toBe(true);
    expect(messages[0].body_text === text.toString("utf8")).toBe(true);
  });

  it("passes the caller's limit into the client's unseen-uid search", async () => {
    const client = new FakeImapClient([1, 2, 3, 4, 5]);
    const adapter = makeImapInboundAdapter(() => client);
    const res = await adapter.send({ limit: 2 }, cfg());
    expect(client.searched).toBe(1);
    expect(client.lastLimit).toBe(2);
    expect((res as any).data).toHaveLength(2);
  });

  it("filters messages received before `since`", async () => {
    const { structure, parts } = multipartFixtures();
    const client = new FakeImapClient([1, 2], {
      1: { envelope: { messageId: "<old@t>", date: "2026-01-01T00:00:00Z" }, structure, parts },
      2: { envelope: { messageId: "<new@t>", date: "2026-09-20T00:00:00Z" }, structure, parts },
    });
    const adapter = makeImapInboundAdapter(() => client);
    const res = await adapter.send({ since: "2026-09-01T00:00:00Z" }, cfg());
    const messages = (res as any).data as ImapMessage[];
    expect(messages.map((m) => m.uid)).toEqual([2]);
  });

  it("maps client errors to a structured FAILED result (still releases the lock and logs out)", async () => {
    const client = new FakeImapClient();
    client.searchUnseenUids = async () => { throw new Error("IMAP session died"); };
    const adapter = makeImapInboundAdapter(() => client);

    const res = await adapter.send({}, cfg());

    expect(res.status).toBe("FAILED");
    expect((res as any).error_message).toContain("IMAP session died");
    expect(client.lockReleased).toBe(1);
    expect(client.loggedOut).toBe(true);
  });

  it("healthCheck: connect+logout success → true; failure → false", async () => {
    const healthy = new FakeImapClient();
    expect(await makeImapInboundAdapter(() => healthy).healthCheck(cfg())).toBe(true);

    const broken = new FakeImapClient();
    broken.connect = async () => { throw new Error("TLS handshake failed"); };
    expect(await makeImapInboundAdapter(() => broken).healthCheck(cfg())).toBe(false);
  });
});
