import { readdirSync, readFileSync } from "fs";
import path from "path";
import { Pool } from "pg";
import { logger } from "../utils/logger";

const MIGRATIONS_DIR = path.join(__dirname, "migrations");

async function ensureMigrationsTable(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id          SERIAL PRIMARY KEY,
      filename    TEXT NOT NULL UNIQUE,
      applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
}

async function getAppliedMigrations(pool: Pool): Promise<Set<string>> {
  const res = await pool.query<{ filename: string }>(
    `SELECT filename FROM schema_migrations`
  );
  return new Set(res.rows.map((r) => r.filename));
}

export async function runMigrations(databaseUrl: string): Promise<void> {
  const pool = new Pool({ connectionString: databaseUrl });

  try {
    await ensureMigrationsTable(pool);
    const applied = await getAppliedMigrations(pool);

    const files = readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith(".sql"))
      .sort(); // lexical order enforces 0001, 0002, ...

    for (const file of files) {
      if (applied.has(file)) {
        logger.info(`skip (already applied): ${file}`);
        continue;
      }

      const sql = readFileSync(path.join(MIGRATIONS_DIR, file), "utf-8");
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query(sql);
        await client.query(
          `INSERT INTO schema_migrations (filename) VALUES ($1)`,
          [file]
        );
        await client.query("COMMIT");
        logger.info(`applied: ${file}`);
      } catch (err) {
        await client.query("ROLLBACK");
        logger.error(`migration failed: ${file}`, { error: err });
        throw err;
      } finally {
        client.release();
      }
    }
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { env } = require("../config/env.schema");
  runMigrations(env.DATABASE_URL)
    .then(() => {
      logger.info("all migrations applied");
      process.exit(0);
    })
    .catch(() => process.exit(1));
}
