/**
 * Quest 02 — Regression guard: scans every .ts file under src/ for
 * INSERT INTO statements targeting the six tenant-scoped tables and
 * asserts each one includes org_id in its column list.
 *
 * This catches future regressions at CI time: any developer who adds
 * an INSERT into audit_log, evaluation_results, scoring_results,
 * verification_results, communication_log, or appeals without org_id
 * will see this test fail.
 */
import * as fs from "fs";
import * as path from "path";

const TABLES = [
  "audit_log",
  "evaluation_results",
  "scoring_results",
  "verification_results",
  "communication_log",
  "appeals",
];

const SRC_DIR = path.resolve(__dirname, "../../src");

function walkDir(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "dist") continue;
      walkDir(full, out);
    } else if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) {
      out.push(full);
    }
  }
  return out;
}

describe("Quest 02 — Tenant isolation regression guard", () => {
  const files = walkDir(SRC_DIR);
  const violations: string[] = [];

  for (const file of files) {
    const content = fs.readFileSync(file, "utf-8");
    const lines = content.split("\n");

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      for (const table of TABLES) {
        // Match INSERT INTO <table> (case-insensitive, with optional whitespace)
        const insertRe = new RegExp(`INSERT\\s+INTO\\s+${table}\\b`, "i");
        if (insertRe.test(line)) {
          // Collect the full statement (may span multiple lines until closing paren or VALUES)
          let statement = line;
          let j = i;
          while (!statement.includes("VALUES") && !statement.includes(")") && j < lines.length - 1) {
            j++;
            statement += " " + lines[j].trim();
          }
          // Check if org_id appears in the column list (before VALUES)
          const colList = statement.split(/VALUES/i)[0];
          if (!colList.includes("org_id")) {
            const rel = path.relative(SRC_DIR, file);
            violations.push(`${rel}:${i + 1} — INSERT INTO ${table} missing org_id`);
          }
        }
      }
    }
  }

  it("every INSERT INTO tenant-scoped tables includes org_id", () => {
    if (violations.length > 0) {
      fail(
        `Found ${violations.length} INSERT statement(s) missing org_id:\n` +
        violations.map((v) => `  • ${v}`).join("\n") +
        `\n\nAll INSERT INTO ${TABLES.join(", ")} must include org_id. See Quest 02.`
      );
    }
  });
});
