/**
 * CI seed script — creates test org and admin user for E2E tests.
 * Used by GitHub Actions CI workflow.
 */
const { Client } = require('pg');
const bcrypt = require('bcryptjs');

(async () => {
  const c = new Client(process.env.DATABASE_URL);
  try {
    await c.connect();
    
    // Create test org
    await c.query(`
      INSERT INTO organizations (org_id, name, sector, deployment_mode)
      VALUES ('00000000-0000-0000-0000-000000000001', 'UROS Test Org', 'STATE_BANK', 'CLOUD')
      ON CONFLICT (org_id) DO NOTHING
    `);
    console.log('✓ Organization created');
    
    // Create admin user with password
    const hash = await bcrypt.hash('Admin@1234', 12);
    await c.query(`
      INSERT INTO users (user_id, org_id, full_name, email, phone, role, active, password_reset_required, password_hash)
      VALUES ('00000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000001', 'CI Admin', 'admin@uros.gov.bd', '+8801700000001', 'ADMIN', true, false, $1)
      ON CONFLICT (user_id) DO NOTHING
    `, [hash]);
    console.log('✓ Admin user created');
    
  } catch (err) {
    console.error('Seed failed:', err);
    process.exit(1);
  } finally {
    await c.end();
  }
})();
