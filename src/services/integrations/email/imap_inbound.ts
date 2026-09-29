/**
 * IMAP inbound email adapter (email:imap_inbound).
 * Fetches unseen messages (with attachment buffers) via ImapFlow.
 * Credential format (BYOK):
 * - apiKey: mailbox username and password joined as "username:password"
 * - baseUrl: "imaps://host:993" (implicit TLS) or "imap://host:143".
 *
 * Testability without network: the adapter is created through
 * `makeImapInboundAdapter(clientFactory)`; production registration uses the
 * real ImapFlow factory, tests inject an in-memory client. This is
 * constructor injection at the module boundary — the production code path
 * never imports test doubles (Rule 18), and it mirrors the injectable
 * `sendFn`/`sleepFn` idiom already used by the legacy SMS connector.
 */

import { Integration, IntegrationResult } from "../_base/types";
import { HttpProviderConfig } from "../sms/shared";
import type { EmailAttachment } from "../email";
import type { Readable } from "node:stream";
import type { MessageStructureObject } from "imapflow";

export interface ImapInput {
  mailbox?: string;
  /** Maximum messages to fetch per call (default 20). */
  limit?: number;
  /** ISO date — only messages received on/after this instant. */
  since?: string;
}

export interface ImapMessage {
  uid: number;
  message_id: string;
  from: string;
  subject: string;
  received_at: string;
  body_text: string;
  attachments: EmailAttachment[];
}

export type ImapOutput = ImapMessage[];

/** Lock handle released when the mailbox session slice is done. */
export interface ImapMailboxLock {
  release(): Promise<void>;
}

/** Minimal client surface the adapter needs (satisfied by ImapFlow). */
export interface ImapClient {
  connect(): Promise<void>;
  getMailboxLock(mailbox: string): Promise<ImapMailboxLock>;
  searchUnseenUids(limit: number): Promise<number[]>;
  fetchMessage(uid: number): Promise<ImapMessage>;
  logout(): Promise<void>;
}

export type ImapClientFactory = (opts: {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  pass: string;
}) => ImapClient;

export function parseImapConfig(config: HttpProviderConfig): {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  pass: string;
} {
  if (!config.baseUrl) {
    throw new Error("IMAP credential is malformed: base_url is required (format imaps://host:993 or imap://host:143).");
  }
  let url: URL;
  try {
    url = new URL(config.baseUrl);
  } catch {
    throw new Error(`IMAP credential is malformed: base_url '${config.baseUrl}' is not a valid URL.`);
  }
  if (url.protocol !== "imaps:" && url.protocol !== "imap:") {
    throw new Error(`IMAP credential is malformed: base_url protocol must be imap: or imaps:, got '${url.protocol}'`);
  }
  const sep = config.apiKey.indexOf(":");
  if (sep <= 0) {
    throw new Error("IMAP credential is malformed: apiKey must be 'username:password'.");
  }
  return {
    host: url.hostname,
    port: Number(url.port) || (url.protocol === "imaps:" ? 993 : 143),
    secure: url.protocol === "imaps:",
    user: config.apiKey.slice(0, sep),
    pass: config.apiKey.slice(sep + 1),
  };
}

/** Collects leaf (non-multipart) nodes of a body structure tree. */
function collectLeafParts(node: MessageStructureObject, out: MessageStructureObject[]): void {
  if (node.childNodes && node.childNodes.length > 0) {
    for (const child of node.childNodes) collectLeafParts(child, out);
    return;
  }
  out.push(node);
}

/** Drains a download stream into a single buffer. */
function readStream(stream: Readable): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on("data", (chunk) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    stream.on("end", () => resolve(Buffer.concat(chunks)));
    stream.on("error", reject);
  });
}

/** Production client factory backed by ImapFlow. */
function imapflowFactory(opts: { host: string; port: number; secure: boolean; user: string; pass: string }): ImapClient {
  // Lazy require keeps ImapFlow out of every non-integration import path.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { ImapFlow } = require("imapflow") as typeof import("imapflow");
  const client = new ImapFlow({
    host: opts.host,
    port: opts.port,
    secure: opts.secure,
    auth: { user: opts.user, pass: opts.pass },
    logger: false,
  });

  return {
    async connect() {
      await client.connect();
    },
    async getMailboxLock(mailbox: string): Promise<ImapMailboxLock> {
      const lock = await client.getMailboxLock(mailbox);
      return { release: () => Promise.resolve(lock.release()) };
    },
    async searchUnseenUids(limit: number): Promise<number[]> {
      // ImapFlow search() resolves false | undefined when nothing matched or
      // the server replied with an error — normalise both to an empty list.
      const found = await client.search({ seen: false }, { uid: true });
      const uids = Array.isArray(found) ? found : [];
      return uids.slice(0, limit);
    },
    async fetchMessage(uid: number): Promise<ImapMessage> {
      let message: ImapMessage = {
        uid,
        message_id: "",
        from: "",
        subject: "",
        received_at: new Date().toISOString(),
        body_text: "",
        attachments: [],
      };
      for await (const msg of client.fetch(
        { uid },
        { uid: true, envelope: true, bodyStructure: true }
      )) {
        const attachments: EmailAttachment[] = [];
        const textChunks: Buffer[] = [];
        const leaves: MessageStructureObject[] = [];
        if (msg.bodyStructure) collectLeafParts(msg.bodyStructure, leaves);
        for (const leaf of leaves) {
          const partId = leaf.part;
          if (!partId) continue;
          // { uid: true } — our `uid` is a UID, not a sequence number.
          const downloaded = await client.download(uid, partId, { uid: true });
          const content = downloaded.content;
          if (!content) continue; // DownloadNotFound — nothing to read
          const buf = await readStream(content);
          const isAttachment =
            leaf.disposition === "attachment" || !leaf.type.startsWith("text/");
          if (isAttachment) {
            attachments.push({
              filename:
                downloaded.meta?.filename ||
                leaf.dispositionParameters?.filename ||
                leaf.parameters?.name ||
                `attachment-${partId}`,
              mime_type: leaf.type || "application/octet-stream",
              buffer: buf,
            });
          } else if (leaf.type.startsWith("text/")) {
            textChunks.push(buf);
          }
        }
        const dateValue = msg.internalDate ?? msg.envelope?.date;
        message = {
          uid,
          message_id: msg.envelope?.messageId ?? "",
          from: msg.envelope?.from?.[0]?.address ?? "",
          subject: msg.envelope?.subject ?? "",
          received_at: dateValue ? new Date(dateValue).toISOString() : new Date().toISOString(),
          body_text: Buffer.concat(textChunks).toString("utf8"),
          attachments,
        };
      }
      return message;
    },
    async logout() {
      await client.logout();
    },
  };
}

/** Builds the IMAP inbound adapter around a client factory. */
export function makeImapInboundAdapter(
  clientFactory: ImapClientFactory = imapflowFactory
): Integration<HttpProviderConfig, ImapInput, ImapOutput> {
  return {
    name: "imap_inbound",
    async send(input: ImapInput, config: HttpProviderConfig): Promise<IntegrationResult<ImapOutput>> {
      const conn = parseImapConfig(config);
      const client = clientFactory(conn);
      const mailbox = input.mailbox ?? "INBOX";
      const limit = input.limit ?? 20;

      let lock: ImapMailboxLock | null = null;
      try {
        await client.connect();
        lock = await client.getMailboxLock(mailbox);
        const uids = await client.searchUnseenUids(limit);
        const messages: ImapMessage[] = [];
        for (const uid of uids) {
          const msg = await client.fetchMessage(uid);
          if (input.since && new Date(msg.received_at) < new Date(input.since)) continue;
          messages.push(msg);
        }
        return { status: "DELIVERED", data: messages };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const code = (err as { code?: string }).code ?? "IMAP_ERROR";
        return { status: "FAILED", error_code: code, error_message: message };
      } finally {
        if (lock) {
          try {
            await lock.release();
          } catch {
            // Release of an already-dead session is best-effort cleanup.
          }
        }
        try {
          await client.logout();
        } catch {
          // Logout of an already-failed connection is best-effort cleanup.
        }
      }
    },
    async healthCheck(config: HttpProviderConfig): Promise<boolean> {
      try {
        const conn = parseImapConfig(config);
        const client = clientFactory(conn);
        await client.connect();
        await client.logout();
        return true;
      } catch {
        return false;
      }
    },
  };
}

export const imapInboundAdapter: Integration<HttpProviderConfig, ImapInput, ImapOutput> = makeImapInboundAdapter();
