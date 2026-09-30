/**
 * Quest 05 Part 5 — GAP 4: Real Mailpit email intake test.
 *
 * 1. Spin up qoder-mailpit container (SMTP:1025, IMAP:1143, API:8025)
 * 2. Seed BYOK credential email_imap with Mailpit host/port/credentials
 * 3. Send a real email with PDF attachment via nodemailer (SMTP → Mailpit)
 * 4. POST /intake/email/fetch — assert 1 unread email listed, attachment detected
 * 5. POST /intake/email/import — assert candidate created, audit logged
 *
 * Uses real Postgres + real Mailpit Docker container.
 */
import { Pool } from "pg";
import request from "supertest";
import path from "path";
import { readdirSync, readFileSync } from "fs";
import nodemailer from "nodemailer";

// ─── Environment override — MUST happen before any src/ import ───────
const REAL_DB = "uros_email_intake_test";
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

jest.setTimeout(45_000);

// ─── Constants ───────────────────────────────────────────────────────
const ORG_ID = "eeeeeeee-8888-8888-8888-888888888888";
const USER_ID = "ffffffff-8888-8888-8888-888888888888";

// Mailpit settings
const MAILPIT_SMTP_HOST = "localhost";
const MAILPIT_SMTP_PORT = 1025;
const MAILPIT_API_URL = "http://localhost:8025";

const pool = new Pool({ connectionString: TEST_URL });
const app = createApp();

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

// Check if Mailpit is available (skip in CI without Mailpit container)
let mailpitAvailable = false;

beforeAll(async () => {
  // Check Mailpit connectivity
  try {
    const net = require("net");
    await new Promise<void>((resolve, reject) => {
      const socket = net.createConnection(MAILPIT_SMTP_PORT, MAILPIT_SMTP_HOST);
      socket.on("connect", () => { socket.destroy(); resolve(); });
      socket.on("error", () => reject(new Error("Mailpit not available")));
      setTimeout(() => { socket.destroy(); reject(new Error("Mailpit timeout")); }, 3000);
    });
    mailpitAvailable = true;
  } catch {
    mailpitAvailable = false;
  }

  await createTestDatabase();

  // Seed org + user
  await pool.query(
    `INSERT INTO organizations (org_id, name, sector, deployment_mode) VALUES ($1, $2, $3, $4)`,
    [ORG_ID, "Email Intake Test Org", "GOVT_NONCADRE", "CLOUD"]
  );
  await pool.query(
    `INSERT INTO users (user_id, org_id, full_name, email, role, password_hash, password_reset_required, preferred_org_id)
     VALUES ($1, $2, 'Email User', $3, 'ADMIN', $4, false, $2)`,
    [USER_ID, ORG_ID, "email@test.com", await hashPassword("Test-Pass-123")]
  );

  // Seed BYOK credential for email_imap
  // baseUrl: http://host:port (Mailpit HTTP API)
  await storeCredential(ORG_ID, "email_imap", "mailpit-api-key", USER_ID, {
    label: "default",
    baseUrl: MAILPIT_API_URL,
  });

  // Login
  const loginRes = await request(app)
    .post("/api/v1/auth/login")
    .send({ email: "email@test.com", password: "Test-Pass-123" });
  expect(loginRes.status).toBe(200);
  accessToken = loginRes.body.access_token;
});

afterAll(async () => {
  await pool.end();
  await dbPool.end();
  await new Promise((r) => setTimeout(r, 500));
  const cleanupPool = new Pool({ connectionString: BASE_URL });
  try {
    await cleanupPool.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='${REAL_DB}' AND pid <> pg_backend_pid()`);
    await cleanupPool.query(`DROP DATABASE IF EXISTS ${REAL_DB}`);
  } catch { /* ignore */ } finally {
    await cleanupPool.end();
  }
});

describe("GAP 4 — Real Mailpit email intake", () => {
  beforeEach(() => {
    if (!mailpitAvailable) {
      console.log("SKIP: Mailpit not available (requires Docker container qoder-mailpit)");
    }
  });

  test("send email via SMTP → fetch via IMAP → import as candidate", async () => {
    if (!mailpitAvailable) {
      console.log("SKIP: Mailpit not available");
      return;
    }
    // Step 1: Send a real email to Mailpit via SMTP with a PDF attachment
    const transporter = nodemailer.createTransport({
      host: MAILPIT_SMTP_HOST,
      port: MAILPIT_SMTP_PORT,
      secure: false,
    });

    const fakePdfContent = Buffer.from("%PDF-1.4 fake CV content for email attachment test");

    const mailInfo = await transporter.sendMail({
      from: '"Applicant Rahim" <rahim@applicant.com>',
      to: "inbox@test.com",
      subject: "Job Application — Rahim Uddin",
      text: "Dear Sir/Madam, I am applying for the position of Officer. Please find my CV attached.",
      html: "<p>Dear Sir/Madam,</p><p>I am applying for the position of Officer. Please find my CV attached.</p><p>Regards,<br/>Rahim Uddin</p>",
      attachments: [
        {
          filename: "rahim_cv.pdf",
          content: fakePdfContent,
          contentType: "application/pdf",
        },
      ],
    });

    console.log("=== GAP 4: Real Mailpit Email Intake ===");
    console.log("Step 1: Email sent via SMTP");
    console.log("Message ID:", mailInfo.messageId);
    console.log("Accepted:", mailInfo.accepted);

    expect(mailInfo.accepted).toContain("inbox@test.com");

    // Wait briefly for Mailpit to process the email
    await new Promise((r) => setTimeout(r, 1500));

    // Step 2: Fetch unread emails via the API (IMAP)
    const fetchRes = await request(app)
      .post("/api/v1/intake/email/fetch")
      .set("Authorization", `Bearer ${accessToken}`)
      .send({});

    console.log("\nStep 2: POST /intake/email/fetch");
    console.log("Status:", fetchRes.status);
    console.log("Body:", JSON.stringify(fetchRes.body, null, 2));

    expect(fetchRes.status).toBe(200);
    expect(fetchRes.body.connected).toBe(true);
    expect(fetchRes.body.emails).toBeDefined();
    expect(fetchRes.body.count).toBeGreaterThanOrEqual(1);

    // Find our email
    const ourEmail = fetchRes.body.emails.find(
      (e: any) => e.subject?.includes("Job Application") || e.from?.includes("rahim@applicant.com")
    );
    expect(ourEmail).toBeDefined();
    console.log("\nFound email:");
    console.log("  From:", ourEmail.from);
    console.log("  Subject:", ourEmail.subject);
    console.log("  Message-ID:", ourEmail.message_id);
    console.log("  Has attachment:", ourEmail.has_attachment);
    console.log("  Attachment names:", ourEmail.attachment_names);

    expect(ourEmail.from).toContain("rahim@applicant.com");
    expect(ourEmail.subject).toContain("Job Application");
    expect(ourEmail.has_attachment).toBe(true);
    console.log("  Attachment info:", ourEmail.attachment_names);

    // Step 3: Import the email as a candidate
    const importRes = await request(app)
      .post("/api/v1/intake/email/import")
      .set("Authorization", `Bearer ${accessToken}`)
      .send({
        message_id: ourEmail.message_id,
        circular_id: "CIRC-EMAIL-001",
      });

    console.log("\nStep 3: POST /intake/email/import");
    console.log("Status:", importRes.status);
    console.log("Body:", JSON.stringify(importRes.body, null, 2));

    expect(importRes.status).toBe(201);
    expect(importRes.body.candidate_id).toBeDefined();
    expect(importRes.body.status).toBe("INTAKE");
    expect(importRes.body.message_id).toBe(ourEmail.message_id);

    // Step 4: Verify candidate in DB
    const dbCheck = await pool.query(
      `SELECT candidate_id, full_name, source_platform, job_circular_id, status
       FROM candidates WHERE candidate_id=$1`,
      [importRes.body.candidate_id]
    );
    console.log("\nStep 4: DB verification");
    console.log("Candidate:", dbCheck.rows[0]);
    expect(dbCheck.rows.length).toBe(1);
    expect(dbCheck.rows[0].source_platform).toBe("Email");
    expect(dbCheck.rows[0].status).toBe("INTAKE");
    expect(dbCheck.rows[0].job_circular_id).toBe("CIRC-EMAIL-001");

    // Step 5: Verify audit log
    const auditCheck = await pool.query(
      `SELECT action, output_value FROM audit_log WHERE org_id=$1 AND entity_id=$2`,
      [ORG_ID, importRes.body.candidate_id]
    );
    console.log("\nStep 5: Audit log");
    console.log("Audit entries:", auditCheck.rows.length);
    console.log("Action:", auditCheck.rows[0]?.action);
    console.log("Output:", JSON.stringify(auditCheck.rows[0]?.output_value));
    expect(auditCheck.rows.length).toBeGreaterThanOrEqual(1);
    expect(auditCheck.rows[0].action).toBe("EMAIL_IMPORT_COMPLETED");

    // Step 6: Verify via Mailpit API that the email exists
    const mailpitApiRes = await fetch("http://localhost:8025/api/v1/messages");
    const mailpitData: any = await mailpitApiRes.json();
    console.log("\nStep 6: Mailpit API verification");
    console.log("Total messages in Mailpit:", mailpitData.total);
    expect(mailpitData.total).toBeGreaterThanOrEqual(1);

    const mpMsg = mailpitData.messages.find((m: any) => m.Subject?.includes("Job Application"));
    if (mpMsg) {
      console.log("Mailpit message:");
      console.log("  ID:", mpMsg.ID);
      console.log("  From:", JSON.stringify(mpMsg.From));
      console.log("  Subject:", mpMsg.Subject);
      console.log("  Size:", mpMsg.Size);
      console.log("  Attachments:", mpMsg.Attachments);
    }
  });

  test("GET /intake/email/unread returns connected=true when IMAP is configured", async () => {
    if (!mailpitAvailable) {
      console.log("SKIP: Mailpit not available");
      return;
    }
    const res = await request(app)
      .get("/api/v1/intake/email/unread")
      .set("Authorization", `Bearer ${accessToken}`);

    console.log("\n=== GET /intake/email/unread (with IMAP configured) ===");
    console.log("Status:", res.status);
    console.log("Connected:", res.body.connected);
    console.log("Email count:", res.body.emails?.length ?? 0);

    expect(res.status).toBe(200);
    expect(res.body.connected).toBe(true);
    expect(Array.isArray(res.body.emails)).toBe(true);
  });
});
