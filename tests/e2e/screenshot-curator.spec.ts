import { test, expect } from "./fixtures/auth";

/**
 * Quest 05 Part 12 — 30 curated E2E screenshots.
 * Run with: npx playwright test screenshot-curator.spec.ts --reporter=list
 */

const OUT = "docs/e2e-evidence/quest-05/e2e";

test.describe("Screenshot Curator", () => {
  test("01 — login page", async ({ page }) => {
    await page.goto("/");
    await page.waitForSelector('input[type="email"]', { timeout: 10_000 });
    await page.screenshot({ path: `${OUT}/01-login.png`, fullPage: true });
  });

  test("02 — dashboard after login", async ({ page, login }) => {
    await login("admin@uros.gov.bd", "Admin@1234");
    await expect(page.locator("text=Live Pipeline").first()).toBeVisible({ timeout: 10_000 });
    await page.screenshot({ path: `${OUT}/02-dashboard.png`, fullPage: true });
  });

  test("03 — intake section", async ({ page, login }) => {
    await login("admin@uros.gov.bd", "Admin@1234");
    await page.click("text=Intake");
    await page.waitForTimeout(1500);
    await expect(page.locator("text=Candidate Intake").first()).toBeVisible({ timeout: 10_000 });
    await page.screenshot({ path: `${OUT}/03-intake.png`, fullPage: true });
  });

  test("04 — email intake sub-tab", async ({ page, login }) => {
    await login("admin@uros.gov.bd", "Admin@1234");
    await page.click("text=Intake");
    await page.waitForTimeout(1000);
    await page.click("text=Email");
    await page.waitForTimeout(500);
    await page.screenshot({ path: `${OUT}/04-email-intake.png`, fullPage: true });
  });

  test("05 — HIL Gates empty state", async ({ page, login }) => {
    await login("admin@uros.gov.bd", "Admin@1234");
    await page.click("text=HIL Gates");
    await page.waitForTimeout(1500);
    await expect(page.locator("text=Human-in-the-Loop Gate Inbox").first()).toBeVisible({ timeout: 10_000 });
    await page.screenshot({ path: `${OUT}/05-hil-gates-empty.png`, fullPage: true });
  });

  test("06 — Brain Studio rule pack editor", async ({ page, login }) => {
    await login("admin@uros.gov.bd", "Admin@1234");
    await page.click("text=Brain Studio");
    await page.waitForTimeout(1500);
    await expect(page.locator("text=Brain Studio — Rule Pack Editor").first()).toBeVisible({ timeout: 10_000 });
    await page.screenshot({ path: `${OUT}/06-brain-studio.png`, fullPage: true });
  });

  test("07 — Brain Studio new pack form", async ({ page, login }) => {
    await login("admin@uros.gov.bd", "Admin@1234");
    await page.click("text=Brain Studio");
    await page.waitForTimeout(1500);
    await page.click("text=+ New Pack");
    await page.waitForTimeout(500);
    await page.screenshot({ path: `${OUT}/07-brain-studio-new-pack.png`, fullPage: true });
  });

  test("08 — Settings Profile tab", async ({ page, login }) => {
    await login("admin@uros.gov.bd", "Admin@1234");
    await page.click("text=Settings");
    await page.waitForTimeout(2000);
    await expect(page.locator("button:has-text('Profile')").first()).toBeVisible({ timeout: 5_000 });
    await page.screenshot({ path: `${OUT}/08-settings-profile.png`, fullPage: true });
  });

  test("09 — Settings Credentials tab", async ({ page, login }) => {
    await login("admin@uros.gov.bd", "Admin@1234");
    await page.click("text=Settings");
    await page.waitForTimeout(1500);
    await page.click("text=Credentials");
    await page.waitForTimeout(500);
    await page.screenshot({ path: `${OUT}/09-settings-credentials.png`, fullPage: true });
  });

  test("10 — Settings Backup tab", async ({ page, login }) => {
    await login("admin@uros.gov.bd", "Admin@1234");
    await page.click("text=Settings");
    await page.waitForTimeout(1500);
    await page.click("text=Backup");
    await page.waitForTimeout(500);
    await page.screenshot({ path: `${OUT}/10-settings-backup.png`, fullPage: true });
  });

  test("11 — Reports tab", async ({ page, login }) => {
    await login("admin@uros.gov.bd", "Admin@1234");
    await page.click("text=Reports");
    await page.waitForTimeout(1500);
    await expect(page.locator("text=Report Generator").first()).toBeVisible({ timeout: 10_000 });
    await page.screenshot({ path: `${OUT}/11-reports.png`, fullPage: true });
  });

  test("12 — Recruitment Analytics", async ({ page, login }) => {
    await login("admin@uros.gov.bd", "Admin@1234");
    await page.click("text=Recruitment Analytics");
    await page.waitForTimeout(1500);
    await page.screenshot({ path: `${OUT}/12-analytics.png`, fullPage: true });
  });

  test("13 — Verification Center", async ({ page, login }) => {
    await login("admin@uros.gov.bd", "Admin@1234");
    await page.click("text=Verification Center");
    await page.waitForTimeout(1500);
    await page.screenshot({ path: `${OUT}/13-verification.png`, fullPage: true });
  });

  test("14 — Appeals panel", async ({ page, login }) => {
    await login("admin@uros.gov.bd", "Admin@1234");
    await page.click("text=Appeals");
    await page.waitForTimeout(1500);
    await page.screenshot({ path: `${OUT}/14-appeals.png`, fullPage: true });
  });

  test("15 — Task Logs", async ({ page, login }) => {
    await login("admin@uros.gov.bd", "Admin@1234");
    await page.click("text=Task Logs");
    await page.waitForTimeout(1500);
    await page.screenshot({ path: `${OUT}/15-task-logs.png`, fullPage: true });
  });

  test("16 — Onboarding", async ({ page, login }) => {
    await login("admin@uros.gov.bd", "Admin@1234");
    await page.click("text=Onboarding");
    await page.waitForTimeout(1500);
    await page.screenshot({ path: `${OUT}/16-onboarding.png`, fullPage: true });
  });

  test("17 — KPI Scores", async ({ page, login }) => {
    await login("admin@uros.gov.bd", "Admin@1234");
    await page.click("text=KPI");
    await page.waitForTimeout(1500);
    await page.screenshot({ path: `${OUT}/17-kpi.png`, fullPage: true });
  });

  test("18 — Departmental Personas", async ({ page, login }) => {
    await login("admin@uros.gov.bd", "Admin@1234");
    await page.click("text=Personas");
    await page.waitForTimeout(1500);
    await page.screenshot({ path: `${OUT}/18-personas.png`, fullPage: true });
  });

  test("19 — Improvement Advisor", async ({ page, login }) => {
    await login("admin@uros.gov.bd", "Admin@1234");
    await page.click("text=Improvement Advisor");
    await page.waitForTimeout(1500);
    await page.screenshot({ path: `${OUT}/19-improvement.png`, fullPage: true });
  });

  test("20 — 7-Dimension Matching", async ({ page, login }) => {
    await login("admin@uros.gov.bd", "Admin@1234");
    await page.click("text=7-Dimension Matching");
    await page.waitForTimeout(1500);
    await page.screenshot({ path: `${OUT}/20-dimensions.png`, fullPage: true });
  });

  test("21 — Digital Exam", async ({ page, login }) => {
    await login("admin@uros.gov.bd", "Admin@1234");
    await page.click("text=Digital Exam Creator");
    await page.waitForTimeout(1500);
    await page.screenshot({ path: `${OUT}/21-digital-exam.png`, fullPage: true });
  });

  test("22 — Fraud Detection", async ({ page, login }) => {
    await login("admin@uros.gov.bd", "Admin@1234");
    await page.click("text=Fraud Detection");
    await page.waitForTimeout(1500);
    await page.screenshot({ path: `${OUT}/22-fraud.png`, fullPage: true });
  });

  test("23 — Reference Checking", async ({ page, login }) => {
    await login("admin@uros.gov.bd", "Admin@1234");
    await page.click("text=Reference Checks");
    await page.waitForTimeout(1500);
    await page.screenshot({ path: `${OUT}/23-references.png`, fullPage: true });
  });

  test("24 — Offboarding", async ({ page, login }) => {
    await login("admin@uros.gov.bd", "Admin@1234");
    await page.click("text=Offboarding");
    await page.waitForTimeout(1500);
    await page.screenshot({ path: `${OUT}/24-offboarding.png`, fullPage: true });
  });

  test("25 — Rediscovery", async ({ page, login }) => {
    await login("admin@uros.gov.bd", "Admin@1234");
    await page.click("text=Candidate Rediscovery");
    await page.waitForTimeout(1500);
    await page.screenshot({ path: `${OUT}/25-rediscovery.png`, fullPage: true });
  });

  test("26 — Audit Stream", async ({ page, login }) => {
    await login("admin@uros.gov.bd", "Admin@1234");
    await page.click("text=Audit");
    await page.waitForTimeout(1500);
    await page.screenshot({ path: `${OUT}/26-audit.png`, fullPage: true });
  });

  test("27 — Bangla dashboard", async ({ page, login }) => {
    await login("admin@uros.gov.bd", "Admin@1234");
    await expect(page.locator("text=Live Pipeline").first()).toBeVisible({ timeout: 10_000 });
    // Switch to Bangla
    await page.click("button:has-text('বাংলা')");
    await page.waitForTimeout(1500);
    await page.screenshot({ path: `${OUT}/27-bn-dashboard.png`, fullPage: true });
  });

  test("28 — Bangla settings", async ({ page, login }) => {
    await login("admin@uros.gov.bd", "Admin@1234");
    await page.click("button:has-text('বাংলা')");
    await page.waitForTimeout(1000);
    await page.click("text=Settings");
    await page.waitForTimeout(1500);
    await page.screenshot({ path: `${OUT}/28-bn-settings.png`, fullPage: true });
  });

  test("29 — Command palette", async ({ page, login }) => {
    await login("admin@uros.gov.bd", "Admin@1234");
    await page.keyboard.press("Meta+k");
    await page.waitForTimeout(1000);
    await page.screenshot({ path: `${OUT}/29-command-palette.png`, fullPage: true });
  });

  test("30 — full pipeline summary", async ({ page, login }) => {
    await login("admin@uros.gov.bd", "Admin@1234");
    await expect(page.locator("text=Live Pipeline").first()).toBeVisible({ timeout: 10_000 });
    // Scroll to capture full dashboard
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(500);
    await page.screenshot({ path: `${OUT}/30-full-pipeline-summary.png`, fullPage: true });
  });
});
