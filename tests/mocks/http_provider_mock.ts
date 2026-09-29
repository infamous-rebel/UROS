/**
 * Mock HTTP provider server (tests-only infrastructure, Rule 18).
 *
 * A tiny configurable HTTP server standing in for external providers
 * (SMS gateways, Graph, Gmail, SendGrid, bdjobs, ATS webhooks, LinkedIn,
 * calendars, VOIP). Production adapters receive `base_url` from BYOK
 * credentials, so tests point the credential's base_url at this server —
 * production code never knows a mock exists and never imports this file.
 *
 * Records every request (method, path, headers, parsed body) so tests can
 * assert the exact wire contract each adapter implements.
 */
import * as http from "http";

/** One recorded provider request. */
export interface RecordedRequest {
  method: string;
  path: string;
  headers: http.IncomingHttpHeaders;
  query: URLSearchParams;
  /** Raw body text ("" for GET). */
  bodyText: string;
  /** Parsed JSON body when Content-Type is application/json. */
  json: unknown;
  /** Parsed form body when Content-Type is application/x-www-form-urlencoded. */
  form: URLSearchParams | null;
}

/** A configured route response. */
export interface MockRoute {
  /** Exact path (without query) to match. */
  path: string;
  status: number;
  /** Response body — static text or a function of the request. */
  body?: string | ((req: RecordedRequest) => string);
  /** Extra response headers (e.g. x-message-id for SendGrid). */
  headers?: Record<string, string>;
}

export class HttpProviderMock {
  private server: http.Server | null = null;
  private port = 0;
  readonly requests: RecordedRequest[] = [];
  private routes: MockRoute[] = [];

  /** Starts the server; resolves to the base URL (http://127.0.0.1:port). */
  async start(): Promise<string> {
    this.server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const bodyText = Buffer.concat(chunks).toString("utf8");
        const contentType = String(req.headers["content-type"] ?? "");
        const url = new URL(req.url ?? "/", `http://127.0.0.1:${this.port}`);
        const record: RecordedRequest = {
          method: req.method ?? "GET",
          path: url.pathname,
          headers: req.headers,
          query: url.searchParams,
          bodyText,
          json: contentType.includes("application/json") && bodyText ? JSON.parse(bodyText) : undefined,
          form: contentType.includes("application/x-www-form-urlencoded") ? new URLSearchParams(bodyText) : null,
        };
        this.requests.push(record);

        const route = this.routes.find((r) => r.path === record.path);
        if (!route) {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "no route configured", path: record.path }));
          return;
        }
        const body = typeof route.body === "function" ? route.body(record) : route.body ?? "";
        res.writeHead(route.status, { "Content-Type": "application/json", ...(route.headers ?? {}) });
        res.end(body);
      });
    });
    await new Promise<void>((resolve) => this.server!.listen(0, "127.0.0.1", resolve));
    const address = this.server.address();
    this.port = typeof address === "object" && address ? address.port : 0;
    return this.baseUrl();
  }

  baseUrl(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  urlFor(path: string): string {
    return `${this.baseUrl()}${path}`;
  }

  /** Replaces the route table (per-test configuration). */
  setRoutes(routes: MockRoute[]): void {
    this.routes = routes;
  }

  /** Clears recorded requests but keeps routes. */
  resetRequests(): void {
    this.requests.length = 0;
  }

  /** The most recent recorded request (throws if none — no silent assertions). */
  lastRequest(): RecordedRequest {
    if (this.requests.length === 0) throw new Error("HttpProviderMock: no requests recorded");
    return this.requests[this.requests.length - 1];
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    await new Promise<void>((resolve, reject) =>
      this.server!.close((err) => (err ? reject(err) : resolve()))
    );
    this.server = null;
  }
}
