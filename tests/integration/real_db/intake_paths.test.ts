/**
 * Quest 05 Part 5 — GAP 2 + GAP 3: Bdjobs 4 paths + Teletalk CV Bank functional tests.
 *
 * Path A — Session scraper: mock Bdjobs server, seed BYOK credential, POST /intake/bdjobs/scrape
 * Path B — CSV import: verify endpoint + response shape (already tested in intake_real.test.ts,
 *           but here we verify the BdjobsPanel CSV path via /intake/import-csv with bdjobs source)
 * Path C — Bdjobs email intake: mock server, POST /intake/bdjobs/email/fetch
 * Path D — ATS webhook: HMAC signature, POST /webhooks/bdjobs, valid + invalid
 * GAP 3  — Teletalk CV Bank: mock server, POST /intake/teletalk/cv-bank/fetch
 *
 * Uses real Postgres (uros_intake_paths_test) + in-process HttpProviderMock.
 */
import { Pool } from "pg";
import request from "supertest";
import path from "path";
import { readdirSync, readFileSync } from "fs";
import { createHmac } from "crypto";

// ─── Environment override — MUST happen before any src/ import ───────
const REAL_DB = "uros_intake_paths_test";
const BASE_URL = process.env.DATABASE_URL_TEST ?? "postgres://uros:uros@localhost:5443/uros";
const TEST_URL = BASE_URL.replace(/\/[^/]+$/, `/${REAL_DB}`);

process.env.DATABASE_URL = TEST_URL;
process.env.JWT_SECRET = process.env.JWT_SECRET ?? "test-jwt-secret-at-least-32-characters-long";
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY ?? "0".repeat(64);
process.env.NODE_ENV = "test";
process.env.LOG_LEVEL = "error";

import { createApp } from "../../../src/api/server";
import { hashPassword } from "../../../src/services/auth/password";
import { pool as dbPool } from "../../../src/database/client";
import { storeCredential } from "../../../src/services/integrations/credential_store";
import { HttpProviderMock } from "../../mocks/http_provider_mock";

jest.setTimeout(30_000);

// ─── Constants ───────────────────────────────────────────────────────
const ORG_ID = "ffffffff-6666-6666-6666-666666666666";
const USER_ID = "aaaaaaaa-6666-6666-6666-666666666666";
const WEBHOOK_SECRET = "test-webhook-secret-for-bdjobs-hmac";

const pool = new Pool({ connectionString: TEST_URL });
const app = createApp();

// Mock servers
const bdjobsMock = new HttpProviderMock();
const teletalkMock = new HttpProviderMock();

async function createTestDatabase(): Promise<void> {
  const adminPool = new Pool({ connectionString: BASE_URL });
  try {
    await adminPool.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='${REAL_DB}' AND pid <> pg_backend_pid()`);
    await adminPool.query(`DROP DATABASE IF EXISTS ${REAL_DB}`);
  } catch { /* DB may not exist */ }
  await adminPool.query(`CREATE DATABASE ${REAL_DB}`);
  await adminPool.end();

  const migrationsDir = path.resolve(__dirname, "../../../src/database/migrations");
  const files = readdirSync(migrationsDir).filter((f: string) => f.endsWith(".sql")).sort();
  for (const file of files) {
    const sql = readFileSync(path.join(migrationsDir, file), "utf8");
    await pool.query(sql);
  }
}

let accessToken: string;
let bdjobsBaseUrl: string;
let teletalkBaseUrl: string;

beforeAll(async () => {
  await createTestDatabase();

  // Seed org + user
  await pool.query(
    `INSERT INTO organizations (org_id, name, sector, deployment_mode) VALUES ($1, $2, $3, $4)`,
    [ORG_ID, "Intake Paths Test Org", "GOVT_NONCADRE", "CLOUD"]
  );
  await pool.query(
    `INSERT INTO users (user_id, org_id, full_name, email, role, password_hash, password_reset_required, preferred_org_id)
     VALUES ($1, $2, 'Paths User', $3, 'ADMIN', $4, false, $2)`,
    [USER_ID, ORG_ID, "paths@test.com", await hashPassword("Test-Pass-123")]
  );

  // Start mock servers
  bdjobsBaseUrl = await bdjobsMock.start();
  teletalkBaseUrl = await teletalkMock.start();

  // Seed BYOK credentials
  await storeCredential(ORG_ID, "bdjobs_scraper", "mock-bdjobs-api-key", USER_ID, {
    label: "default",
    baseUrl: `${bdjobsBaseUrl}/applicants`,
  });
  await storeCredential(ORG_ID, "bdjobs_email", "mock-bdjobs-email-key", USER_ID, {
    label: "default",
    baseUrl: `${bdjobsBaseUrl}/emails`,
  });
  await storeCredential(ORG_ID, "bdjobs_webhook", "mock-bdjobs-wh-key", USER_ID, {
    label: "default",
  });
  await storeCredential(ORG_ID, "bdjobs", WEBHOOK_SECRET, USER_ID, {
    label: "webhook_secret",
  });
  await storeCredential(ORG_ID, "teletalk_cv_bank", "mock-teletalk-key", USER_ID, {
    label: "default",
    baseUrl: `${teletalkBaseUrl}/cv-bank`,
  });

  // Login
  const loginRes = await request(app)
    .post("/api/v1/auth/login")
    .send({ email: "paths@test.com", password: "Test-Pass-123" });
  expect(loginRes.status).toBe(200);
  accessToken = loginRes.body.access_token;
});

afterAll(async () => {
  await pool.end();
  await dbPool.end();
  await bdjobsMock.stop();
  await teletalkMock.stop();
  await new Promise((r) => setTimeout(r, 500));
  const cleanupPool = new Pool({ connectionString: BASE_URL });
  try {
    await cleanupPool.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='${REAL_DB}' AND pid <> pg_backend_pid()`);
    await cleanupPool.query(`DROP DATABASE IF EXISTS ${REAL_DB}`);
  } catch { /* ignore */ } finally {
    await cleanupPool.end();
  }
});

// ═══════════════════════════════════════════════════════════════════════
// GAP 2 — Bdjobs 4 paths
// ═══════════════════════════════════════════════════════════════════════

describe("GAP 2 — Bdjobs 4 paths", () => {
  // ─── Path A: Session Scraper ───────────────────────────────────────
  describe("Path A — Session Scraper", () => {
    test("scrapes applicants from mock Bdjobs server and creates candidates", async () => {
      // Configure mock to return 5 applicants
      bdjobsMock.setRoutes([
        {
          path: "/applicants",
          status: 200,
          body: JSON.stringify({
            applicants: [
              { name: "Rahim Bdjobs", email: "rahim@bdjobs.com", phone: "01711111111" },
              { name: "Karim Bdjobs", email: "karim@bdjobs.com", phone: "01722222222" },
              { name: "Salma Bdjobs", email: "salma@bdjobs.com", phone: "01733333333" },
              { name: "Nasrin Bdjobs", email: "nasrin@bdjobs.com", phone: "01744444444" },
              { name: "Jamal Bdjobs", email: "jamal@bdjobs.com", phone: "01755555555" },
            ],
          }),
        },
      ]);

      const res = await request(app)
        .post("/api/v1/intake/bdjobs/scrape")
        .set("Authorization", `Bearer ${accessToken}`)
        .send({ job_url: `${bdjobsBaseUrl}/applicants` });

      console.log("=== PATH A: Session Scraper ===");
      console.log("Status:", res.status);
      console.log("Body:", JSON.stringify(res.body, null, 2));

      expect(res.status).toBe(202);
      expect(res.body.scraped).toBe(5);
      expect(res.body.imported).toBe(5);
      expect(res.body.failed).toBe(0);
      expect(res.body.batch_id).toBeDefined();
      expect(res.body.status).toBe("COMPLETED");

      // Verify candidates in DB
      const dbCheck = await pool.query(
        `SELECT candidate_id, full_name, source_platform, status FROM candidates WHERE org_id=$1 AND source_platform='bdjobs'`,
        [ORG_ID]
      );
      console.log("DB candidates:", dbCheck.rows.length);
      expect(dbCheck.rows.length).toBe(5);
      dbCheck.rows.forEach((r: any) => {
        expect(r.status).toBe("INTAKE");
        expect(r.source_platform).toBe("bdjobs");
      });

      // Verify mock was called correctly
      const mockReq = bdjobsMock.lastRequest();
      expect(mockReq.method).toBe("GET");
      expect(mockReq.path).toBe("/applicants");
      expect(mockReq.headers["authorization"]).toBe("Bearer mock-bdjobs-api-key");

      // Verify batch record
      const batchCheck = await pool.query(
        `SELECT batch_id, source, status, total_items, imported FROM import_batches WHERE org_id=$1 AND source='bdjobs'`,
        [ORG_ID]
      );
      expect(batchCheck.rows.length).toBe(1);
      expect(batchCheck.rows[0].total_items).toBe(5);
      expect(batchCheck.rows[0].imported).toBe(5);

      // Verify audit log
      const auditCheck = await pool.query(
        `SELECT action, output_value FROM audit_log WHERE org_id=$1 AND action='BDJOBS_SCRAPE_COMPLETED'`,
        [ORG_ID]
      );
      expect(auditCheck.rows.length).toBe(1);
      console.log("Audit:", auditCheck.rows[0].action, JSON.stringify(auditCheck.rows[0].output_value));
    });
  });

  // ─── Path B: CSV Import (via BdjobsPanel CSV tab) ─────────────────
  describe("Path B — CSV Import", () => {
    test("CSV import endpoint returns correct shape for BdjobsPanel CSV tab", async () => {
      const rows = [
        { Name: "BdjobsCSV Alice", Email: "alice@bdjcsv.com", Phone: "01766666666" },
        { Name: "BdjobsCSV Bob", Email: "bob@bdjcsv.com", Phone: "01777777777" },
      ];

      const res = await request(app)
        .post("/api/v1/intake/import-csv")
        .set("Authorization", `Bearer ${accessToken}`)
        .send({
          circular_id: "BDJCSV-001",
          column_mapping: { name: "Name", email: "Email", phone: "Phone" },
          rows,
        });

      console.log("=== PATH B: CSV Import ===");
      console.log("Endpoint: POST /api/v1/intake/import-csv");
      console.log("Status:", res.status);
      console.log("Response shape:", JSON.stringify(res.body, null, 2));

      expect(res.status).toBe(202);
      expect(res.body).toHaveProperty("batch_id");
      expect(res.body).toHaveProperty("total", 2);
      expect(res.body).toHaveProperty("imported", 2);
      expect(res.body).toHaveProperty("failed", 0);
      expect(res.body).toHaveProperty("status", "ACCEPTED");

      // Verify candidates
      const dbCheck = await pool.query(
        `SELECT candidate_id, full_name FROM candidates WHERE org_id=$1 AND job_circular_id='BDJCSV-001'`,
        [ORG_ID]
      );
      expect(dbCheck.rows.length).toBe(2);
      console.log("CSV candidates:", dbCheck.rows.map((r: any) => r.full_name));
    });
  });

  // ─── Path C: Bdjobs Email Intake ──────────────────────────────────
  describe("Path C — Bdjobs Email Intake", () => {
    test("fetches Bdjobs-format emails from mock and creates candidates", async () => {
      bdjobsMock.setRoutes([
        {
          path: "/emails",
          status: 200,
          body: JSON.stringify({
            emails: [
              { name: "EmailApp Rahim", email: "rahim-email@bdjobs.com", phone: "01788888888", message_id: "bdj-email-001" },
              { name: "EmailApp Karim", email: "karim-email@bdjobs.com", phone: "01799999999", message_id: "bdj-email-002" },
              { name: "EmailApp Salma", email: "salma-email@bdjobs.com", phone: "01700000001", message_id: "bdj-email-003" },
            ],
          }),
        },
      ]);

      const res = await request(app)
        .post("/api/v1/intake/bdjobs/email/fetch")
        .set("Authorization", `Bearer ${accessToken}`)
        .send({});

      console.log("=== PATH C: Bdjobs Email Intake ===");
      console.log("Status:", res.status);
      console.log("Body:", JSON.stringify(res.body, null, 2));

      expect(res.status).toBe(202);
      expect(res.body.fetched).toBe(3);
      expect(res.body.imported).toBe(3);
      expect(res.body.candidates).toBeDefined();
      expect(res.body.candidates.length).toBe(3);

      // Verify candidates in DB
      const dbCheck = await pool.query(
        `SELECT candidate_id, full_name, email, source_platform, status
         FROM candidates WHERE org_id=$1 AND source_platform='bdjobs' AND full_name LIKE 'EmailApp%'`,
        [ORG_ID]
      );
      console.log("Email intake candidates:", dbCheck.rows.length);
      expect(dbCheck.rows.length).toBe(3);
      expect(dbCheck.rows[0].email).toBeDefined();
      expect(dbCheck.rows[0].status).toBe("INTAKE");

      // Verify audit
      const auditCheck = await pool.query(
        `SELECT action FROM audit_log WHERE org_id=$1 AND action='BDJOBS_EMAIL_FETCH_COMPLETED'`,
        [ORG_ID]
      );
      expect(auditCheck.rows.length).toBe(1);
      console.log("Audit:", auditCheck.rows[0].action);
    });
  });

  // ─── Path D: ATS Webhook ──────────────────────────────────────────
  describe("Path D — ATS Webhook", () => {
    test("valid HMAC signature → candidate created + delivery ack", async () => {
      const payload = {
        applicant: {
          name: "Webhook Applicant",
          email: "webhook@bdjobs.com",
          phone: "01712345678",
          circular_id: "BDJWH-CIRC-001",
        },
      };
      const rawBody = JSON.stringify(payload);
      const signature = "sha256=" + createHmac("sha256", WEBHOOK_SECRET).update(rawBody).digest("hex");

      const res = await request(app)
        .post(`/api/v1/webhooks/bdjobs?org_id=${ORG_ID}`)
        .set("Content-Type", "application/json")
        .set("X-Uros-Signature", signature)
        .send(rawBody);

      console.log("=== PATH D: ATS Webhook (valid signature) ===");
      console.log("Status:", res.status);
      console.log("Body:", JSON.stringify(res.body, null, 2));

      expect(res.status).toBe(200);
      expect(res.body.status).toBe("RECEIVED");
      expect(res.body.event_id).toBeDefined();

      // Verify candidate created
      const dbCheck = await pool.query(
        `SELECT candidate_id, full_name, email, source_platform, job_circular_id, status
         FROM candidates WHERE org_id=$1 AND full_name='Webhook Applicant'`,
        [ORG_ID]
      );
      console.log("Webhook candidate:", dbCheck.rows[0]);
      expect(dbCheck.rows.length).toBe(1);
      expect(dbCheck.rows[0].email).toBe("webhook@bdjobs.com");
      expect(dbCheck.rows[0].source_platform).toBe("bdjobs");
      expect(dbCheck.rows[0].status).toBe("INTAKE");
      expect(dbCheck.rows[0].job_circular_id).toBe("BDJWH-CIRC-001");

      // Verify webhook event logged
      const eventCheck = await pool.query(
        `SELECT event_id, connector, signature_valid, processed FROM inbound_webhook_events WHERE event_id=$1`,
        [res.body.event_id]
      );
      expect(eventCheck.rows.length).toBe(1);
      expect(eventCheck.rows[0].signature_valid).toBe(true);
      expect(eventCheck.rows[0].processed).toBe(true);
      console.log("Webhook event: valid=", eventCheck.rows[0].signature_valid, "processed=", eventCheck.rows[0].processed);
    });

    test("invalid HMAC signature → 401, no candidate created", async () => {
      const payload = {
        applicant: {
          name: "Bad Webhook Applicant",
          email: "bad@bdjobs.com",
          phone: "01700000000",
        },
      };
      const rawBody = JSON.stringify(payload);
      const badSignature = "sha256=deadbeef0000111122223333444455556666777788889999aaaabbbbccccddddeeee";

      const countBefore = await pool.query(`SELECT COUNT(*) FROM candidates WHERE org_id=$1`, [ORG_ID]);

      const res = await request(app)
        .post(`/api/v1/webhooks/bdjobs?org_id=${ORG_ID}`)
        .set("Content-Type", "application/json")
        .set("X-Uros-Signature", badSignature)
        .send(rawBody);

      console.log("=== PATH D: ATS Webhook (INVALID signature) ===");
      console.log("Status:", res.status);
      console.log("Body:", JSON.stringify(res.body, null, 2));

      expect(res.status).toBe(401);
      expect(res.body.error).toContain("Invalid");

      // Verify NO candidate created
      const countAfter = await pool.query(`SELECT COUNT(*) FROM candidates WHERE org_id=$1`, [ORG_ID]);
      expect(Number(countAfter.rows[0].count)).toBe(Number(countBefore.rows[0].count));
      console.log("Candidate count unchanged:", countAfter.rows[0].count);

      // Verify webhook event logged with signature_valid=false
      const eventCheck = await pool.query(
        `SELECT event_id, signature_valid, processed FROM inbound_webhook_events WHERE org_id=$1 AND connector='bdjobs' ORDER BY received_at DESC LIMIT 1`,
        [ORG_ID]
      );
      expect(eventCheck.rows[0].signature_valid).toBe(false);
      console.log("Invalid webhook logged: signature_valid=", eventCheck.rows[0].signature_valid);
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════
// GAP 3 — Teletalk CV Bank
// ═══════════════════════════════════════════════════════════════════════

describe("GAP 3 — Teletalk CV Bank", () => {
  test("fetches CV Bank records from mock and creates candidates", async () => {
    teletalkMock.setRoutes([
      {
        path: "/cv-bank",
        status: 200,
        body: JSON.stringify({
          records: [
            { name: "Teletalk Rahim", phone: "01811111111", email: "telrahim@test.com" },
            { name: "Teletalk Karim", phone: "01822222222", email: "telkarim@test.com" },
            { name: "Teletalk Salma", phone: "01833333333", email: "telsalma@test.com" },
            { name: "Teletalk Nasrin", phone: "01844444444", email: "tel nasrin@test.com" },
          ],
        }),
      },
    ]);

    const res = await request(app)
      .post("/api/v1/intake/teletalk/cv-bank/fetch")
      .set("Authorization", `Bearer ${accessToken}`)
      .send({});

    console.log("=== GAP 3: Teletalk CV Bank ===");
    console.log("Status:", res.status);
    console.log("Body:", JSON.stringify(res.body, null, 2));

    expect(res.status).toBe(202);
    expect(res.body.fetched).toBe(4);
    expect(res.body.imported).toBe(4);
    expect(res.body.candidates.length).toBe(4);
    expect(res.body.status).toBe("COMPLETED");

    // Verify candidates in DB
    const dbCheck = await pool.query(
      `SELECT candidate_id, full_name, phone_primary, source_platform, status
       FROM candidates WHERE org_id=$1 AND source_platform='Teletalk'`,
      [ORG_ID]
    );
    console.log("Teletalk candidates:", dbCheck.rows.length);
    expect(dbCheck.rows.length).toBe(4);
    dbCheck.rows.forEach((r: any) => {
      expect(r.status).toBe("INTAKE");
      expect(r.source_platform).toBe("Teletalk");
    });

    // Verify batch record
    const batchCheck = await pool.query(
      `SELECT batch_id, source, status, total_items, imported FROM import_batches WHERE org_id=$1 AND source='Teletalk'`,
      [ORG_ID]
    );
    expect(batchCheck.rows.length).toBe(1);
    expect(batchCheck.rows[0].total_items).toBe(4);
    expect(batchCheck.rows[0].imported).toBe(4);
    console.log("Batch:", batchCheck.rows[0].batch_id, "total:", batchCheck.rows[0].total_items);

    // Verify audit
    const auditCheck = await pool.query(
      `SELECT action, output_value FROM audit_log WHERE org_id=$1 AND action='TELETALK_CVBANK_FETCH_COMPLETED'`,
      [ORG_ID]
    );
    expect(auditCheck.rows.length).toBe(1);
    console.log("Audit:", auditCheck.rows[0].action, JSON.stringify(auditCheck.rows[0].output_value));

    // Verify mock was called with correct auth
    const mockReq = teletalkMock.lastRequest();
    expect(mockReq.method).toBe("GET");
    expect(mockReq.path).toBe("/cv-bank");
    expect(mockReq.headers["authorization"]).toBe("Bearer mock-teletalk-key");
  });

  test("returns 400 when teletalk_cv_bank credential not configured", async () => {
    // Use a different org with no credentials
    const otherOrg = "bbbbbbbb-7777-7777-7777-777777777777";
    const otherUser = "cccccccc-7777-7777-7777-777777777777";
    await pool.query(
      `INSERT INTO organizations (org_id, name, sector, deployment_mode) VALUES ($1, $2, $3, $4)`,
      [otherOrg, "No-Cred Org", "GOVT_NONCADRE", "CLOUD"]
    );
    await pool.query(
      `INSERT INTO users (user_id, org_id, full_name, email, role, password_hash, password_reset_required, preferred_org_id)
       VALUES ($1, $2, 'NoCred User', $3, 'ADMIN', $4, false, $2)`,
      [otherUser, otherOrg, "nocred@test.com", await hashPassword("Test-Pass-123")]
    );

    const loginRes = await request(app)
      .post("/api/v1/auth/login")
      .send({ email: "nocred@test.com", password: "Test-Pass-123" });
    const otherToken = loginRes.body.access_token;

    const res = await request(app)
      .post("/api/v1/intake/teletalk/cv-bank/fetch")
      .set("Authorization", `Bearer ${otherToken}`)
      .send({});

    console.log("=== Teletalk CV Bank (no credential) ===");
    console.log("Status:", res.status);
    console.log("Body:", JSON.stringify(res.body, null, 2));

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("teletalk_cv_bank");
  });
});
