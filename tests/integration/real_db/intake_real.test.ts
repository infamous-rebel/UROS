/**
 * Quest 05 Part 5 — Real-DB verification for Intake Panels.
 *
 * Tests:
 * 1. POST /intake/import-csv — import 3 candidates via CSV, confirm all 3 created
 * 2. POST /intake/upload-cv — upload a PDF CV, confirm candidate created in INTAKE
 * 3. POST /intake/email/import — import an email as candidate, confirm created
 * 4. GET  /intake/batches — list import batches, confirm CSV batch appears
 * 5. GET  /intake/email/unread — returns structured response (even if empty)
 * 6. GET  /intake/bdjobs/status — returns configured=false when no credentials
 * 7. GET  /intake/teletalk/status — returns configured=false when no credentials
 *
 * Uses a real Postgres database (uros_part5_intake_test) with migrations.
 */
import { Pool } from "pg";
import request from "supertest";
import path from "path";
import { readdirSync, readFileSync } from "fs";

// ─── Environment override — MUST happen before any src/ import ───────
const REAL_DB = "uros_part5_intake_test";
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

jest.setTimeout(30_000);

// ─── Constants ───────────────────────────────────────────────────────
const ORG_ID = "dddddddd-5555-5555-5555-555555555555";
const USER_ID = "eeeeeeee-5555-5555-5555-555555555555";

const pool = new Pool({ connectionString: TEST_URL });
const app = createApp();

async function createTestDatabase(): Promise<void> {
  const adminPool = new Pool({ connectionString: BASE_URL });
  try {
    await adminPool.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='${REAL_DB}' AND pid <> pg_backend_pid()`);
    await adminPool.query(`DROP DATABASE IF EXISTS ${REAL_DB}`);
  } catch { /* DB may not exist yet */ }
  await adminPool.query(`CREATE DATABASE ${REAL_DB}`);
  await adminPool.end();

  // Run migrations
  const migrationsDir = path.resolve(__dirname, "../../../src/database/migrations");
  const files = readdirSync(migrationsDir).filter((f: string) => f.endsWith(".sql")).sort();
  for (const file of files) {
    const sql = readFileSync(path.join(migrationsDir, file), "utf8");
    await pool.query(sql);
  }
}

let accessToken: string;

beforeAll(async () => {
  await createTestDatabase();

  // Seed org + user
  await pool.query(
    `INSERT INTO organizations (org_id, name, sector, deployment_mode) VALUES ($1, $2, $3, $4)`,
    [ORG_ID, "Part5 Intake Test Org", "GOVT_NONCADRE", "CLOUD"]
  );
  await pool.query(
    `INSERT INTO users (user_id, org_id, full_name, email, role, password_hash, password_reset_required, preferred_org_id)
     VALUES ($1, $2, 'Part5 User', $3, 'ADMIN', $4, false, $2)`,
    [USER_ID, ORG_ID, "part5@test.com", await hashPassword("Test-Pass-123")]
  );

  // Login to get token
  const loginRes = await request(app)
    .post("/api/v1/auth/login")
    .send({ email: "part5@test.com", password: "Test-Pass-123" });
  expect(loginRes.status).toBe(200);
  accessToken = loginRes.body.access_token;
});

afterAll(async () => {
  await pool.end();
  await dbPool.end();
  // Wait briefly for connections to fully close before dropping DB
  await new Promise((r) => setTimeout(r, 500));
  const cleanupPool = new Pool({ connectionString: BASE_URL });
  try {
    await cleanupPool.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='${REAL_DB}' AND pid <> pg_backend_pid()`);
    await cleanupPool.query(`DROP DATABASE IF EXISTS ${REAL_DB}`);
  } catch { /* ignore teardown races */ } finally {
    await cleanupPool.end();
  }
});

// ─── Tests ───────────────────────────────────────────────────────────

describe("Quest 05 Part 5 — Intake (real DB)", () => {
  test("POST /intake/import-csv imports 3 candidates from CSV", async () => {
    const rows = [
      { Name: "Alice TestCSV", Email: "alice@csv.com", Phone: "01700000001" },
      { Name: "Bob TestCSV", Email: "bob@csv.com", Phone: "01700000002" },
      { Name: "Carol TestCSV", Email: "carol@csv.com", Phone: "01700000003" },
    ];

    const res = await request(app)
      .post("/api/v1/intake/import-csv")
      .set("Authorization", `Bearer ${accessToken}`)
      .send({
        circular_id: "CIRC-001",
        column_mapping: { name: "Name", email: "Email", phone: "Phone" },
        rows,
      });

    expect(res.status).toBe(202);
    expect(res.body.batch_id).toBeDefined();
    expect(res.body.total).toBe(3);
    expect(res.body.imported).toBe(3);
    expect(res.body.failed).toBe(0);
    expect(res.body.status).toBe("ACCEPTED");

    // Verify all 3 candidates exist in DB
    const dbCheck = await pool.query(
      `SELECT candidate_id, full_name, source_platform, status FROM candidates WHERE org_id=$1 AND source_platform='CSV'`,
      [ORG_ID]
    );
    expect(dbCheck.rows.length).toBe(3);
    const names = dbCheck.rows.map((r: { full_name: string }) => r.full_name).sort();
    expect(names).toEqual(["Alice TestCSV", "Bob TestCSV", "Carol TestCSV"]);
    // All should be in INTAKE status
    dbCheck.rows.forEach((r: { status: string }) => {
      expect(r.status).toBe("INTAKE");
    });
  });

  test("POST /intake/upload-cv creates candidate in INTAKE queue", async () => {
    // Create a minimal PDF-like buffer (the route accepts any file with .pdf extension)
    const fakePdf = Buffer.from("%PDF-1.4 fake cv content for testing");

    const res = await request(app)
      .post("/api/v1/intake/upload-cv")
      .set("Authorization", `Bearer ${accessToken}`)
      .attach("file", fakePdf, "test_candidate_cv.pdf");

    expect(res.status).toBe(201);
    expect(res.body.candidate_id).toBeDefined();
    expect(res.body.file_name).toBe("test_candidate_cv.pdf");
    expect(res.body.status).toBe("INTAKE");

    // Verify candidate exists
    const dbCheck = await pool.query(
      `SELECT candidate_id, full_name, status FROM candidates WHERE candidate_id=$1`,
      [res.body.candidate_id]
    );
    expect(dbCheck.rows.length).toBe(1);
    expect(dbCheck.rows[0].status).toBe("INTAKE");

    // Verify document record exists
    const docCheck = await pool.query(
      `SELECT doc_id, candidate_id, doc_type, file_location FROM candidate_documents WHERE candidate_id=$1`,
      [res.body.candidate_id]
    );
    expect(docCheck.rows.length).toBe(1);
    expect(docCheck.rows[0].doc_type).toBe("CV");
  });

  test("POST /intake/email/import creates candidate from email", async () => {
    const res = await request(app)
      .post("/api/v1/intake/email/import")
      .set("Authorization", `Bearer ${accessToken}`)
      .send({
        message_id: "<test-msg-001@mail.example.com>",
        circular_id: "CIRC-002",
      });

    expect(res.status).toBe(201);
    expect(res.body.candidate_id).toBeDefined();
    expect(res.body.status).toBe("INTAKE");
    expect(res.body.message_id).toBe("<test-msg-001@mail.example.com>");

    // Verify candidate exists
    const dbCheck = await pool.query(
      `SELECT candidate_id, full_name, source_platform, status FROM candidates WHERE candidate_id=$1`,
      [res.body.candidate_id]
    );
    expect(dbCheck.rows.length).toBe(1);
    expect(dbCheck.rows[0].source_platform).toBe("Email");
    expect(dbCheck.rows[0].status).toBe("INTAKE");
  });

  test("GET /intake/batches lists the CSV import batch", async () => {
    const res = await request(app)
      .get("/api/v1/intake/batches")
      .set("Authorization", `Bearer ${accessToken}`);

    expect(res.status).toBe(200);
    expect(res.body.batches).toBeDefined();
    expect(Array.isArray(res.body.batches)).toBe(true);
    expect(res.body.batches.length).toBeGreaterThanOrEqual(1);

    // Find our CSV batch
    const csvBatch = res.body.batches.find((b: { source: string }) => b.source === "CSV");
    expect(csvBatch).toBeDefined();
    expect(csvBatch.total_items).toBe(3);
    expect(csvBatch.imported).toBe(3);
    expect(csvBatch.status).toBe("ACCEPTED");
  });

  test("GET /intake/email/unread returns structured response", async () => {
    const res = await request(app)
      .get("/api/v1/intake/email/unread")
      .set("Authorization", `Bearer ${accessToken}`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("emails");
    expect(res.body).toHaveProperty("connected");
    expect(Array.isArray(res.body.emails)).toBe(true);
  });

  test("GET /intake/bdjobs/status returns configured=false when no credentials", async () => {
    const res = await request(app)
      .get("/api/v1/intake/bdjobs/status")
      .set("Authorization", `Bearer ${accessToken}`);

    expect(res.status).toBe(200);
    expect(res.body.configured).toBe(false);
    expect(res.body.message).toContain("Bdjobs");
  });

  test("GET /intake/teletalk/status returns configured=false when no credentials", async () => {
    const res = await request(app)
      .get("/api/v1/intake/teletalk/status")
      .set("Authorization", `Bearer ${accessToken}`);

    expect(res.status).toBe(200);
    expect(res.body.configured).toBe(false);
    expect(res.body.message).toContain("Teletalk");
  });
});
