/**
 * Quest 05 Part 7 — Settings screenshots.
 * Logs in as seeded admin, navigates to Settings tab, clicks each of the
 * 12 sub-tabs, and takes a screenshot of each.
 */
import { chromium } from "playwright";
import { mkdirSync } from "fs";

const UI_ORIGIN = "http://localhost:5173";
const API_ORIGIN = "http://localhost:3000";
const OUT_DIR = "docs/e2e-evidence/quest-05/settings";

// Seed admin credentials (must exist in the running DB)
const ADMIN_EMAIL = "admin@uros.local";
const ADMIN_PASS = "Admin-Pass-123";

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

  // 1. Navigate to UI
  console.log("→ Navigating to", UI_ORIGIN);
  await page.goto(UI_ORIGIN, { waitUntil: "networkidle" });

  // 2. Log in
  console.log("→ Logging in as", ADMIN_EMAIL);
  await page.fill("#login-email", ADMIN_EMAIL);
  await page.fill("#login-password", ADMIN_PASS);
  await page.click('button[type="submit"]');
  await page.waitForTimeout(3000);

  // Check if login succeeded — if we're still on login, try the seeded credentials
  const url = page.url();
  console.log("→ After login URL:", url);

  // 3. Click Settings tab
  console.log("→ Clicking Settings tab");
  const settingsTab = page.locator("button", { hasText: "Settings" });
  await settingsTab.click();
  await page.waitForTimeout(2000);

  // 4. Screenshot the sidebar (full Settings view showing Profile tab)
  await page.screenshot({ path: `${OUT_DIR}/00-settings-sidebar.png`, fullPage: false });
  console.log("✓ 00-settings-sidebar.png");

  // 5. Click each tab and screenshot
  const tabs = [
    { label: "Profile", file: "01-profile" },
    { label: "Organization", file: "02-organization" },
    { label: "Users", file: "03-users" },
    { label: "Credentials", file: "04-credentials" },
    { label: "Fallback Chains", file: "05-fallback" },
    { label: "Integrations", file: "06-integrations" },
    { label: "Personas", file: "07-personas" },
    { label: "KPI Templates", file: "08-kpi" },
    { label: "Onboarding", file: "09-onboarding" },
    { label: "Backup", file: "10-backup" },
    { label: "Audit", file: "11-audit" },
    { label: "Data Export", file: "12-export" },
  ];

  for (const t of tabs) {
    const btn = page.locator("nav button", { hasText: t.label });
    await btn.click();
    await page.waitForTimeout(1500);
    await page.screenshot({ path: `${OUT_DIR}/${t.file}.png`, fullPage: false });
    console.log(`✓ ${t.file}.png`);
  }

  await browser.close();
  console.log("\n✅ All Settings screenshots saved to", OUT_DIR);
}

main().catch((err) => {
  console.error("Screenshot failed:", err.message);
  process.exit(1);
});
