/**
 * Quest 01: Idempotent seed script.
 *
 * Creates a demo org, admin user, one rule pack with version + rules,
 * 3 candidates, and 1 job circular. Safe to re-run: every insert checks
 * for existing data first and skips if already present.
 *
 * Usage: npm run seed
 * Requires: DATABASE_URL in environment. Prints the first admin's
 * one-time set-password link (Quest 05 Decision Lock 1 bootstrap).
 */
import { Pool } from "pg";
import { createHash, randomBytes } from "crypto";

const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}

// Fixed UUIDs for idempotency — same seed always produces the same IDs.
const DEMO_ORG_ID = "00000000-0000-0000-0000-000000000001";
const DEMO_ADMIN_ID = "00000000-0000-0000-0000-000000000002";
const DEMO_RULE_PACK_ID = "00000000-0000-0000-0000-000000000003";
const DEMO_RULE_PACK_VERSION_ID = "00000000-0000-0000-0000-000000000004";
const DEMO_CIRCULAR_ID = "CIRC-DEMO-001";

const CANDIDATE_IDS = [
  "CAND-SEED-001",
  "CAND-SEED-002",
  "CAND-SEED-003",
];

async function seed(): Promise<void> {
  const pool = new Pool({ connectionString: DATABASE_URL });

  try {
    console.log("Starting seed...");

    // 1. Demo organization
    await pool.query(`
      INSERT INTO organizations (org_id, name, sector, deployment_mode)
      VALUES ($1, 'Demo Bank Ltd', 'STATE_BANK', 'CLOUD')
      ON CONFLICT (org_id) DO NOTHING
    `, [DEMO_ORG_ID]);
    console.log("  ✓ Organization: Demo Bank Ltd");

    // 2. Admin user — Quest 05 Decision Lock 1: the first admin is
    // created with password_reset_required = true and NO password.
    // Sign-in is only possible after completing a set-password link
    // (SMS-first / email fallback) or in-person admin handoff; there are
    // no temp passwords and no admin bypass.
    await pool.query(`
      INSERT INTO users (user_id, org_id, full_name, email, phone, role, active, password_reset_required)
      VALUES ($1, $2, 'Demo Admin', 'admin@demobank.example.com', '+8801700000009', 'ADMIN', true, true)
      ON CONFLICT (user_id) DO NOTHING
    `, [DEMO_ADMIN_ID, DEMO_ORG_ID]);
    console.log("  ✓ Admin user: admin@demobank.example.com (password_reset_required — use a reset link to set the first password)");

    // Bootstrap (Quest 05 Decision Lock 1): the first admin has no
    // password and cannot sign in, so the seed run itself performs the
    // in-person handoff — it issues the one-time set-password link and
    // prints it as a copyable string. Issued only while the account still
    // requires a reset, so re-running seed after setup prints nothing.
    const needsReset = await pool.query(
      `SELECT password_reset_required FROM users WHERE user_id = $1`,
      [DEMO_ADMIN_ID]
    );
    if (needsReset.rows[0]?.password_reset_required) {
      const raw = randomBytes(32).toString("base64url");
      const tokenHash = createHash("sha256").update(raw, "utf8").digest("hex");
      await pool.query(
        `INSERT INTO password_reset_tokens (user_id, token_hash, expires_at, issued_by, issued_via, channel)
         VALUES ($1, $2, now() + interval '30 minutes', $1, 'ADMIN_HANDOFF', 'IN_PERSON')`,
        [DEMO_ADMIN_ID, tokenHash]
      );
      const base = process.env.APP_PUBLIC_URL ?? "http://localhost:3000";
      console.log("  ⚡ First-admin set-password link (one-time, expires in 30 minutes):");
      console.log(`    ${base}/reset-password?token=${raw}`);
    }

    // 3. Rule pack + version
    await pool.query(`
      INSERT INTO rule_packs (rule_pack_id, org_id, name, sector, circular_id, is_active, created_by)
      VALUES ($1, $2, 'Demo Scoring Rules', 'STATE_BANK', $3, true, $4)
      ON CONFLICT (rule_pack_id) DO NOTHING
    `, [DEMO_RULE_PACK_ID, DEMO_ORG_ID, DEMO_CIRCULAR_ID, DEMO_ADMIN_ID]);

    await pool.query(`
      INSERT INTO rule_pack_versions (version_id, rule_pack_id, version_number, change_summary, created_by)
      VALUES ($1, $2, 1, 'Initial seed version', $3)
      ON CONFLICT (rule_pack_id, version_number) DO NOTHING
    `, [DEMO_RULE_PACK_VERSION_ID, DEMO_RULE_PACK_ID, DEMO_ADMIN_ID]);
    console.log("  ✓ Rule pack + version (v1)");

    // 4. Scoring rules
    const scoringRules = [
      {
        code: "SCI_001",
        field: "academic.cgpa",
        operator: "GTE",
        threshold: JSON.stringify({ value: 3.0 }),
        weight: 40,
        reason: "CGPA_MEETS_THRESHOLD",
      },
      {
        code: "SCI_002",
        field: "academic.passing_year",
        operator: "GTE",
        threshold: JSON.stringify({ value: 2020 }),
        weight: 30,
        reason: "RECENT_GRADUATE",
      },
      {
        code: "SCI_003",
        field: "data_confidence",
        operator: "EQ",
        threshold: JSON.stringify({ value: "High" }),
        weight: 30,
        reason: "HIGH_CONFIDENCE_DATA",
      },
    ];

    for (const rule of scoringRules) {
      // Check for existing rule by (rule_pack_version_id, rule_code) — no unique
      // constraint on this pair, so we must check manually for idempotency.
      const existing = await pool.query(
        `SELECT rule_id FROM rules WHERE rule_pack_version_id=$1 AND rule_code=$2`,
        [DEMO_RULE_PACK_VERSION_ID, rule.code]
      );
      if (existing.rowCount && existing.rowCount > 0) continue;

      await pool.query(`
        INSERT INTO rules (rule_pack_version_id, rule_code, rule_type, field_path, operator, threshold_value, weight, fail_reason_code, active)
        VALUES ($1, $2, 'SCORING', $3, $4, $5, $6, $7, true)
      `, [DEMO_RULE_PACK_VERSION_ID, rule.code, rule.field, rule.operator, rule.threshold, rule.weight, rule.reason]);
    }
    console.log("  ✓ Scoring rules (3)");

    // 5. Candidates
    const candidateData = [
      { id: CANDIDATE_IDS[0], name: "Rahim Uddin", phone: "01711111111", nid: "1234567890", division: "Dhaka" },
      { id: CANDIDATE_IDS[1], name: "Fatema Akter", phone: "01722222222", nid: "9876543210", division: "Chittagong" },
      { id: CANDIDATE_IDS[2], name: "Karim Hossain", phone: "01733333333", nid: "5555555555", division: "Rajshahi" },
    ];

    for (const c of candidateData) {
      await pool.query(`
        INSERT INTO candidates (candidate_id, org_id, full_name, phone_primary, national_id, division,
                                source_platform, application_date, job_circular_id, position_applied,
                                data_confidence, status)
        VALUES ($1, $2, $3, $4, $5, $6, 'Teletalk', now(), $7, 'Officer (Cash)', 'High', 'INTAKE')
        ON CONFLICT (candidate_id) DO NOTHING
      `, [c.id, DEMO_ORG_ID, c.name, c.phone, c.nid, c.division, DEMO_CIRCULAR_ID]);
    }
    console.log("  ✓ Candidates (3)");

    console.log("\n═══════════════════════════════════════════");
    console.log("  Seed complete!");
    console.log("═══════════════════════════════════════════");
    console.log(`  Org ID:       ${DEMO_ORG_ID}`);
    console.log(`  Admin ID:     ${DEMO_ADMIN_ID}`);
    console.log(`  Circular:     ${DEMO_CIRCULAR_ID}`);
    console.log(`  Rule Pack:    ${DEMO_RULE_PACK_ID}`);
    console.log(`  RP Version:   ${DEMO_RULE_PACK_VERSION_ID}`);
    // Quest 05 Decision Lock 1: no printed credentials and no admin
    // bypass — the only way in is the one-time set-password link printed
    // above. No long-lived JWT is minted here anymore.
    console.log("═══════════════════════════════════════════\n");
  } finally {
    await pool.end();
  }
}

seed().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});
