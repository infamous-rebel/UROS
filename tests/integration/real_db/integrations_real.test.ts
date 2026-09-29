/**
 * Quest 04 — Real-database integrations test.
 *
 * Connects to a real Postgres, applies ALL migrations via the production
 * runner (twice — proving ledger idempotency), mounts the real Express
 * app, and verifies end-to-end:
 *   1. GET /integrations/providers — all 31 adapters registered.
 *   2. BYOK credential lifecycle (HTTP): store (encrypted at rest) →
 *      list (masked, never plaintext) → rotate → revoke.
 *   3. Credential service round-trip: decrypt equals the plaintext key.
 *   4. Fallback chain routes: get (unconfigured) → put → get; unknown
 *      connector → 400.
 *   5. POST /integrations/test: unknown connector → 400, missing
 *      credential → 409, healthy probe → 200 + audit row.
 *   6. CommunicationAgent.sendBatch → dispatcher → REAL HTTP provider
 *      mock: rendered bn body arrives on the wire, communication_log
 *      SENT row with provider tracking, MESSAGE_DISPATCHED audit.
 *   7. Fallback chain in action: first provider 4xx → logged FAILED,
 *      second provider succeeds → SENT.
 *   8. Interface-only connector → FAILED NOT_IMPLEMENTED (loud, logged).
 *   9. Missing credential → FAILED MISSING_CREDENTIAL (no silent retry).
 *  10. Tenant isolation: org B cannot use org A's credentials.
 *  11. applications/import → import_batches row → intake_agent.fetchBatch
 *      (tenant-scoped) — the stub is gone.
 *
 * Requires: a running Postgres accessible at DATABASE_URL_TEST (falls
 * back to postgres://uros:uros@localhost:5443/uros).
 */
import { Pool } from "pg";
import jwt from "jsonwebtoken";
import request from "supertest";

// ─── Environment override — MUST happen before any src/ import ───────
const REAL_DB = "uros_integrations_test";
const BASE_URL = process.env.DATABASE_URL_TEST ?? "postgres://uros:uros@localhost:5443/uros";
const TEST_URL = BASE_URL.replace(/\/[^/]+$/, `/${REAL_DB}`);

process.env.DATABASE_URL = TEST_URL;
process.env.JWT_SECRET = process.env.JWT_SECRET ?? "test-jwt-secret-at-least-32-characters-long";
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY ?? "0".repeat(64);
process.env.NODE_ENV = "test";
process.env.LOG_LEVEL = "error";

// Now safe to import src/ modules (pool binds to TEST_URL)
import { createApp } from "../../../src/api/server";
import { pool } from "../../../src/database/client";
import { runMigrations } from "../../../src/database/migrate";
import { storeCredential, listCredentials, revokeCredential, requireCredential } from "../../../src/services/integrations/credential_store";
import { MissingCredentialError } from "../../../src/services/integrations/credential_store";
import { setFallbackChain } from "../../../src/services/integrations/_base/fallback";
import { resetAllCircuits } from "../../../src/services/integrations/_base/circuit_breaker";
import { sendBatch } from "../../../src/agents/communication_agent";
import { fetchBatch } from "../../../src/agents/intake_agent";
import { dispatchMessage } from "../../../src/services/communication/dispatcher";
import { HttpProviderMock } from "../../mocks/http_provider_mock";

// ─── Constants ───────────────────────────────────────────────────────
const ORG_A = "aaaaaaaa-1111-1111-1111-111111111111";
const ORG_B = "bbbbbbbb-2222-2222-2222-222222222222";
const ADMIN_A = "cccccccc-3333-3333-3333-333333333333";
const CAND_A = "CAND-INTEG-A";
const CAND_B = "CAND-INTEG-B";

function token(userId: string, orgId: string, role: string): string {
  return jwt.sign({ user_id: userId, org_id: orgId, role }, process.env.JWT_SECRET!, { expiresIn: 3600 });
}

// ─── Database bootstrap ──────────────────────────────────────────────
async function createTestDatabase(): Promise<void> {
  const adminPool = new Pool({ connectionString: BASE_URL });
  try {
    await adminPool.query(`DROP DATABASE IF EXISTS ${REAL_DB}`);
    await adminPool.query(`CREATE DATABASE ${REAL_DB}`);
  } finally {
    await adminPool.end();
  }
}

async function seedData(): Promise<void> {
  await pool.query(
    `INSERT INTO organizations(org_id, name, sector, deployment_mode, default_language)
     VALUES ($1, 'Integrations Org A', 'GOVT_NONCADRE', 'CLOUD', 'bn'), ($2, 'Integrations Org B', 'CORPORATE', 'CLOUD', 'en')`,
    [ORG_A, ORG_B]
  );
  await pool.query(
    `INSERT INTO users(user_id, org_id, full_name, email, role)
     VALUES ($1, $2, 'Admin Alpha', 'admin-alpha@integ-test.local', 'ADMIN'),
            ($3, $4, 'Admin Beta', 'admin-beta@integ-test.local', 'ADMIN')`,
    [ADMIN_A, ORG_A, "dddddddd-4444-4444-4444-444444444444", ORG_B]
  );
  await pool.query(
    `INSERT INTO candidates(candidate_id, org_id, full_name, status, job_circular_id, phone_primary, email, preferred_language, position_applied)
     VALUES ($1, $2, 'Nusrat Jahan', 'SHORTLISTED', 'CIRC-INTEG', '+8801712345678', 'nusrat@example.com', 'bn', 'Assistant Teacher'),
            ($3, $2, 'Rafiq Islam', 'SHORTLISTED', 'CIRC-INTEG', '+8801812345678', NULL, 'en', 'Assistant Teacher')`,
    [CAND_A, ORG_A, CAND_B]
  );
}

// ─── Test suite ──────────────────────────────────────────────────────
describe("Quest 04 — Integrations (real DB)", () => {
  const app = createApp();
  const adminTokenA = token(ADMIN_A, ORG_A, "ADMIN");
  const adminTokenB = token("dddddddd-4444-4444-4444-444444444444", ORG_B, "ADMIN");
  let mock: HttpProviderMock;

  beforeAll(async () => {
    await createTestDatabase();
    // Production migration runner — applied twice proves ledger idempotency.
    await runMigrations(TEST_URL);
    await runMigrations(TEST_URL);
    await seedData();
    resetAllCircuits();
    mock = new HttpProviderMock();
    await mock.start();
  }, 60_000);

  afterAll(async () => {
    if (mock) await mock.stop();
    await pool.end();
    const adminPool = new Pool({ connectionString: BASE_URL });
    try {
      await adminPool.query(`DROP DATABASE IF EXISTS ${REAL_DB}`);
    } finally {
      await adminPool.end();
    }
  });

  // ─── 1. Provider catalog ───────────────────────────────────────────
  it("GET /integrations/providers lists all 31 adapters, every one registered", async () => {
    const res = await request(app).get("/api/v1/integrations/providers").set("Authorization", `Bearer ${adminTokenA}`);
    expect(res.status).toBe(200);
    expect(res.body.providers).toHaveLength(31);
    expect(res.body.providers.every((p: any) => p.registered === true)).toBe(true);
  });

  it("requires authentication", async () => {
    const res = await request(app).get("/api/v1/integrations/providers");
    expect(res.status).toBe(401);
  });

  // ─── 2. Credential lifecycle over real HTTP ────────────────────────
  it("POST /credentials stores encrypted; GET /credentials masks the key", async () => {
    const res = await request(app)
      .post("/api/v1/credentials")
      .set("Authorization", `Bearer ${adminTokenA}`)
      .send({ connector: "sms_teletalk", label: "default", api_key: "plaintext-secret-key-1", base_url: mock.baseUrl() });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ connector: "sms_teletalk", label: "default", status: "ACTIVE" });

    const list = await request(app).get("/api/v1/credentials").set("Authorization", `Bearer ${adminTokenA}`);
    expect(list.status).toBe(200);
    const row = list.body.credentials.find((c: any) => c.connector === "sms_teletalk");
    expect(row.masked_key).not.toContain("plaintext-secret-key-1");

    // Raw storage is never plaintext (encrypted at rest).
    const raw = await pool.query(`SELECT encrypted_value, iv, auth_tag FROM api_credentials WHERE credential_id=$1`, [row.credential_id]);
    const joined = `${raw.rows[0].encrypted_value}${raw.rows[0].iv}${raw.rows[0].auth_tag}`;
    expect(joined).not.toContain("plaintext-secret-key-1");
  });

  it("credential service round-trip decrypts to the exact plaintext; rotation deactivates the prior credential", async () => {
    await storeCredential(ORG_A, "sms_robi", "robi-live-key-99", ADMIN_A, { baseUrl: mock.baseUrl() });
    const resolved = await requireCredential(ORG_A, "sms_robi");
    expect(resolved.apiKey).toBe("robi-live-key-99");
    expect(resolved.baseUrl).toBe(mock.baseUrl());

    await storeCredential(ORG_A, "sms_robi", "robi-rotated-key-100", ADMIN_A, { baseUrl: mock.baseUrl() });
    const rotated = await requireCredential(ORG_A, "sms_robi");
    expect(rotated.apiKey).toBe("robi-rotated-key-100");

    const list = await listCredentials(ORG_A);
    const robi = list.filter((c) => c.connector === "sms_robi");
    expect(robi.some((c) => c.status === "REVOKED")).toBe(true);
    expect(robi.some((c) => c.status === "ACTIVE")).toBe(true);

    await revokeCredential(ORG_A, robi.find((c) => c.status === "ACTIVE")!.credential_id, ADMIN_A);
    await expect(requireCredential(ORG_A, "sms_robi")).rejects.toBeInstanceOf(MissingCredentialError);
  });

  // ─── 3. Fallback chain routes ──────────────────────────────────────
  it("PUT/GET /integrations/fallback/:messageType persists the org's chain; unknown connectors → 400", async () => {
    const unconfigured = await request(app).get("/api/v1/integrations/fallback/SMS").set("Authorization", `Bearer ${adminTokenA}`);
    expect(unconfigured.status).toBe(200);
    expect(unconfigured.body).toMatchObject({ message_type: "SMS", configured: false, provider_order: [] });

    const put = await request(app)
      .put("/api/v1/integrations/fallback/SMS")
      .set("Authorization", `Bearer ${adminTokenA}`)
      .send({ provider_order: ["sms_airtel", "sms_teletalk"] });
    expect(put.status).toBe(200);

    const get = await request(app).get("/api/v1/integrations/fallback/SMS").set("Authorization", `Bearer ${adminTokenA}`);
    expect(get.body).toMatchObject({ message_type: "SMS", configured: true, provider_order: ["sms_airtel", "sms_teletalk"] });

    const bad = await request(app)
      .put("/api/v1/integrations/fallback/SMS")
      .set("Authorization", `Bearer ${adminTokenA}`)
      .send({ provider_order: ["sms_airtel", "not_a_connector"] });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toContain("not_a_connector");

    // Org B's chain is independent (tenant-scoped config).
    const orgB = await request(app).get("/api/v1/integrations/fallback/SMS").set("Authorization", `Bearer ${adminTokenB}`);
    expect(orgB.body.configured).toBe(false);
  });

  // ─── 4. Live provider test endpoint ────────────────────────────────
  it("POST /integrations/test: 400 unknown connector; 409 without credential; 200 healthy probe", async () => {
    const unknown = await request(app)
      .post("/api/v1/integrations/test")
      .set("Authorization", `Bearer ${adminTokenA}`)
      .send({ connector: "not_a_connector" });
    expect(unknown.status).toBe(400);

    const missing = await request(app)
      .post("/api/v1/integrations/test")
      .set("Authorization", `Bearer ${adminTokenA}`)
      .send({ connector: "sms_banglalink" });
    expect(missing.status).toBe(409);
    expect(missing.body.healthy).toBe(false);

    // teletalk credential exists (stored via /credentials above) pointing at
    // the mock; healthCheck GETs the send URL's origin.
    mock.setRoutes([{ path: "/", status: 200, body: JSON.stringify({ ok: true }) }]);
    const healthy = await request(app)
      .post("/api/v1/integrations/test")
      .set("Authorization", `Bearer ${adminTokenA}`)
      .send({ connector: "sms_teletalk" });
    expect(healthy.status).toBe(200);
    expect(healthy.body).toEqual({ healthy: true });

    const audit = await pool.query(
      `SELECT action FROM audit_log WHERE entity_type='INTEGRATION' AND entity_id='sms_teletalk' ORDER BY timestamp DESC LIMIT 1`
    );
    expect(audit.rows[0].action).toBe("INTEGRATION_TEST_RUN");
  });

  // ─── 5. CommunicationAgent → dispatcher → real provider mock ───────
  it("sendBatch renders the bn body, transports over HTTP, and logs SENT with provider tracking", async () => {
    mock.resetRequests();
    mock.setRoutes([{ path: "/api/v1/send", status: 200, body: JSON.stringify({ message_id: "TL-777" }) }]);
    await storeCredential(ORG_A, "sms_teletalk", "teletalk-live-key-1", ADMIN_A, { baseUrl: mock.baseUrl() });
    await setFallbackChain(ORG_A, "SMS", ["sms_teletalk"], ADMIN_A);

    const candidates = (await pool.query(`SELECT * FROM candidates WHERE candidate_id=$1`, [CAND_A])).rows;
    await sendBatch(candidates as any, "APPLICATION_RECEIVED", "SMS", ORG_A);

    // The rendered bn body actually crossed the wire.
    const req = mock.lastRequest();
    expect(req.method).toBe("POST");
    expect(req.json).toMatchObject({ to: "+8801712345678" });
    expect(String((req.json as any).message)).toContain("প্রিয় Nusrat Jahan");
    expect(String((req.json as any).message)).toContain("Integrations Org A");

    const log = await pool.query(
      `SELECT status, provider_name, provider_message_id, template_code, channel FROM communication_log
       WHERE candidate_id=$1 AND org_id=$2 ORDER BY sent_at DESC LIMIT 1`,
      [CAND_A, ORG_A]
    );
    expect(log.rows[0]).toMatchObject({ status: "SENT", provider_name: "sms_teletalk", provider_message_id: "TL-777", channel: "SMS" });

    const audit = await pool.query(
      `SELECT action, reason_code FROM audit_log WHERE entity_type='COMMUNICATION' AND entity_id=$1 ORDER BY timestamp DESC LIMIT 1`,
      [CAND_A]
    );
    expect(audit.rows[0]).toMatchObject({ action: "MESSAGE_DISPATCHED", reason_code: "DISPATCH_SUCCESS" });
  });

  it("fallback chain: first provider 4xx → FAILED row, second provider succeeds → SENT", async () => {
    mock.resetRequests();
    mock.setRoutes([
      { path: "/v1/sms", status: 400, body: JSON.stringify({ error: "invalid msisdn" }) },
      { path: "/api/v1/send", status: 200, body: JSON.stringify({ message_id: "TL-778" }) },
    ]);
    await storeCredential(ORG_A, "sms_airtel", "airtel-live-key-1", ADMIN_A, { baseUrl: mock.baseUrl() });
    await setFallbackChain(ORG_A, "SMS", ["sms_airtel", "sms_teletalk"], ADMIN_A);

    const outcome = await dispatchMessage(
      ORG_A,
      "SMS",
      { candidate_id: CAND_B, to: "+8801812345678", message: "Fallback chain test" },
      { candidate_id: CAND_B, template_code: "INTERVIEW_SCHEDULE", actor: ADMIN_A }
    );

    expect(outcome.status).toBe("SENT");
    expect(outcome.connector).toBe("sms_teletalk");
    expect(outcome.attempted_chain).toEqual(["sms_airtel", "sms_teletalk"]);

    const logs = await pool.query(
      `SELECT status, provider_name, error_code FROM communication_log
       WHERE candidate_id=$1 AND org_id=$2 ORDER BY sent_at ASC`,
      [CAND_B, ORG_A]
    );
    expect(logs.rows).toHaveLength(2);
    expect(logs.rows[0]).toMatchObject({ status: "FAILED", provider_name: "sms_airtel", error_code: "HTTP_400" });
    expect(logs.rows[1]).toMatchObject({ status: "SENT", provider_name: "sms_teletalk" });
  });

  it("interface-only connector → FAILED NOT_IMPLEMENTED with communication_log + audit rows", async () => {
    await storeCredential(ORG_A, "messaging_telegram", "telegram-token-123", ADMIN_A);
    await setFallbackChain(ORG_A, "SMS", ["messaging_telegram"], ADMIN_A);

    const outcome = await dispatchMessage(
      ORG_A,
      "SMS",
      { candidate_id: CAND_A, to: "+8801712345678", message: "Telegram probe" },
      { candidate_id: CAND_A, template_code: "INTERVIEW_SCHEDULE", actor: ADMIN_A }
    );

    expect(outcome.status).toBe("FAILED");
    expect(outcome.error_code).toBe("NOT_IMPLEMENTED");

    const log = await pool.query(
      `SELECT status, error_code, provider_name FROM communication_log WHERE candidate_id=$1 AND provider_name='messaging_telegram' ORDER BY sent_at DESC LIMIT 1`,
      [CAND_A]
    );
    expect(log.rows[0]).toMatchObject({ status: "FAILED", error_code: "NOT_IMPLEMENTED", provider_name: "messaging_telegram" });

    const audit = await pool.query(
      `SELECT action FROM audit_log WHERE entity_type='COMMUNICATION' AND entity_id=$1 AND action='MESSAGE_DISPATCH_FAILED' ORDER BY timestamp DESC LIMIT 1`,
      [CAND_A]
    );
    expect(audit.rows).toHaveLength(1);
  });

  it("missing credential → FAILED MISSING_CREDENTIAL (no silent fallback)", async () => {
    await setFallbackChain(ORG_A, "SMS", ["sms_banglalink"], ADMIN_A);
    const outcome = await dispatchMessage(
      ORG_A,
      "SMS",
      { candidate_id: CAND_A, to: "+8801712345678", message: "no cred" },
      { candidate_id: CAND_A, template_code: "GENERIC", actor: ADMIN_A }
    );
    expect(outcome.status).toBe("FAILED");
    expect(outcome.error_code).toBe("MISSING_CREDENTIAL");
  });

  it("tenant isolation: org B's dispatch cannot see org A's credentials", async () => {
    await setFallbackChain(ORG_B, "SMS", ["sms_teletalk"], ADMIN_A);
    const outcome = await dispatchMessage(
      ORG_B,
      "SMS",
      { candidate_id: CAND_A, to: "+8801712345678", message: "cross-tenant probe" },
      { candidate_id: CAND_A, template_code: "GENERIC", actor: ADMIN_A }
    );
    // Org A has an sms_teletalk credential; org B must not resolve it.
    expect(outcome.status).toBe("FAILED");
    expect(outcome.error_code).toBe("MISSING_CREDENTIAL");
    expect(outcome.error_message).toContain(ORG_B);
  });

  it("GET /integrations/status returns circuit + rate-limit snapshots scoped to the org", async () => {
    const res = await request(app).get("/api/v1/integrations/status").set("Authorization", `Bearer ${adminTokenA}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.circuits)).toBe(true);
    expect(Array.isArray(res.body.rate_limits)).toBe(true);
    expect(res.body.circuits.every((c: any) => c.org_id === ORG_A)).toBe(true);
  });

  // ─── 6. Import batches: the intake stub is gone ────────────────────
  it("POST /applications/import persists import_batches; fetchBatch loads it tenant-scoped", async () => {
    const res = await request(app)
      .post("/api/v1/applications/import")
      .set("Authorization", `Bearer ${adminTokenA}`)
      .send({
        source: "Teletalk",
        circular_id: "CIRC-INTEG",
        applications: [{ candidate_id: "CAND-INTEG-C", full_name: "New Applicant", phone_primary: "+8801911111111" }],
      });
    expect(res.status).toBe(202);
    expect(res.body.batch_id).toMatch(/^BATCH-CIRC-INTEG-/);
    expect(res.body).toMatchObject({ imported: 1, failed: [], status: "ACCEPTED" });

    const batch = await fetchBatch(res.body.batch_id, ORG_A);
    expect(batch).toMatchObject({ batch_id: res.body.batch_id, org_id: ORG_A, circular_id: "CIRC-INTEG", source: { platform: "Teletalk" } });

    // Unknown batch → loud failure, no stub data.
    await expect(fetchBatch("BATCH-DOES-NOT-EXIST", ORG_A)).rejects.toThrow(/Import batch not found/);
    // Another org cannot read org A's batch.
    await expect(fetchBatch(res.body.batch_id, ORG_B)).rejects.toThrow(/Import batch not found/);
  });

  it("migrations ledger records every applied file (32 files)", async () => {
    const res = await pool.query(`SELECT count(*)::int AS n FROM schema_migrations`);
    expect(res.rows[0].n).toBe(32);
  });
});
