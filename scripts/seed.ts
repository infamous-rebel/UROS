/**
 * Quest 01: Idempotent seed script.
 *
 * Creates a demo org, admin user, one rule pack with version + rules,
 * 3 candidates, and 1 job circular. Safe to re-run: every insert checks
 * for existing data first and skips if already present.
 *
 * Usage: npm run seed
 * Requires: DATABASE_URL and JWT_SECRET in environment.
 */
import { Pool } from "pg";
import jwt from "jsonwebtoken";

const DATABASE_URL = process.env.DATABASE_URL;
const JWT_SECRET = process.env.JWT_SECRET || "dev-secret-must-be-at-least-32-chars-long!!";

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

    // 2. Admin user
    await pool.query(`
      INSERT INTO users (user_id, org_id, full_name, email, role, active)
      VALUES ($1, $2, 'Demo Admin', 'admin@demobank.example.com', 'ADMIN', true)
      ON CONFLICT (user_id) DO NOTHING
    `, [DEMO_ADMIN_ID, DEMO_ORG_ID]);
    console.log("  ✓ Admin user: admin@demobank.example.com");

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

    // 6. Generate and display JWT
    const token = jwt.sign(
      { user_id: DEMO_ADMIN_ID, org_id: DEMO_ORG_ID, role: "ADMIN" },
      JWT_SECRET,
      { expiresIn: "24h" }
    );

    console.log("\n═══════════════════════════════════════════");
    console.log("  Seed complete!");
    console.log("═══════════════════════════════════════════");
    console.log(`  Org ID:       ${DEMO_ORG_ID}`);
    console.log(`  Admin ID:     ${DEMO_ADMIN_ID}`);
    console.log(`  Circular:     ${DEMO_CIRCULAR_ID}`);
    console.log(`  Rule Pack:    ${DEMO_RULE_PACK_ID}`);
    console.log(`  RP Version:   ${DEMO_RULE_PACK_VERSION_ID}`);
    console.log(`\n  JWT (24h):\n  ${token}`);
    console.log("═══════════════════════════════════════════\n");
  } finally {
    await pool.end();
  }
}

seed().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});
