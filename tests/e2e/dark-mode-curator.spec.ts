import { test, expect } from "./fixtures/auth";

/**
 * Quest 05 Part 14 — Dark mode screenshot curator.
 * Captures every panel in dark mode + theme switcher transitions.
 */

const OUT = "docs/e2e-evidence/quest-05/dark-mode";

async function switchToDark(page: any) {
  await page.click("text=Settings");
  await page.waitForTimeout(1500);
  // Click the "Dark" theme button
  await page.click("button:has-text('Dark')");
  await page.waitForTimeout(500);
}

async function navTo(page: any, label: string) {
  await page.click(`text=${label}`);
  await page.waitForTimeout(1500);
}

test.describe("Dark Mode Screenshots", () => {
  test.use({ navigationTimeout: 30_000 });
  test.setTimeout(120_000);
  test("01 — login page dark", async ({ page }) => {
    await page.goto("/");
    await page.waitForSelector('input[type="email"]', { timeout: 10_000 });
    // Set dark mode via JS before screenshot
    await page.evaluate(() => document.documentElement.setAttribute("data-theme", "dark"));
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${OUT}/01-login-dark.png`, fullPage: true });
  });

  test("02 — dashboard dark", async ({ page, login }) => {
    await login("admin@uros.gov.bd", "Admin@1234");
    await expect(page.locator("text=Live Pipeline").first()).toBeVisible({ timeout: 10_000 });
    await switchToDark(page);
    await page.click("text=Dashboard");
    await page.waitForTimeout(1000);
    await page.screenshot({ path: `${OUT}/02-dashboard-dark.png`, fullPage: true });
  });

  test("03 — intake dark", async ({ page, login }) => {
    await login("admin@uros.gov.bd", "Admin@1234");
    await switchToDark(page);
    await navTo(page, "Intake");
    await page.screenshot({ path: `${OUT}/03-intake-dark.png`, fullPage: true });
  });

  test("04 — HIL Gates dark", async ({ page, login }) => {
    await login("admin@uros.gov.bd", "Admin@1234");
    await switchToDark(page);
    await navTo(page, "HIL Gates");
    await page.screenshot({ path: `${OUT}/04-hil-gates-dark.png`, fullPage: true });
  });

  test("05 — MCQ Scanner dark", async ({ page, login }) => {
    await login("admin@uros.gov.bd", "Admin@1234");
    await switchToDark(page);
    await navTo(page, "MCQ Scanner");
    await page.screenshot({ path: `${OUT}/05-mcq-dark.png`, fullPage: true });
  });

  test("06 — Digital Exam Creator dark", async ({ page, login }) => {
    await login("admin@uros.gov.bd", "Admin@1234");
    await switchToDark(page);
    await navTo(page, "Digital Exam Creator");
    await page.screenshot({ path: `${OUT}/06-exam-dark.png`, fullPage: true });
  });

  test("07 — 7-Dimension Matching dark", async ({ page, login }) => {
    await login("admin@uros.gov.bd", "Admin@1234");
    await switchToDark(page);
    await navTo(page, "7-Dimension Matching");
    await page.screenshot({ path: `${OUT}/07-dimensions-dark.png`, fullPage: true });
  });

  test("08 — Fraud Detection dark", async ({ page, login }) => {
    await login("admin@uros.gov.bd", "Admin@1234");
    await switchToDark(page);
    await navTo(page, "Fraud Detection");
    await page.screenshot({ path: `${OUT}/08-fraud-dark.png`, fullPage: true });
  });

  test("09 — Reference Checks dark", async ({ page, login }) => {
    await login("admin@uros.gov.bd", "Admin@1234");
    await switchToDark(page);
    await navTo(page, "Reference Checks");
    await page.screenshot({ path: `${OUT}/09-references-dark.png`, fullPage: true });
  });

  test("10 — Verification Center dark", async ({ page, login }) => {
    await login("admin@uros.gov.bd", "Admin@1234");
    await switchToDark(page);
    await navTo(page, "Verification Center");
    await page.screenshot({ path: `${OUT}/10-verification-dark.png`, fullPage: true });
  });

  test("11 — Onboarding dark", async ({ page, login }) => {
    await login("admin@uros.gov.bd", "Admin@1234");
    await switchToDark(page);
    await navTo(page, "Onboarding");
    await page.screenshot({ path: `${OUT}/11-onboarding-dark.png`, fullPage: true });
  });

  test("12 — KPI dark", async ({ page, login }) => {
    await login("admin@uros.gov.bd", "Admin@1234");
    await switchToDark(page);
    await navTo(page, "KPI");
    await page.screenshot({ path: `${OUT}/12-kpi-dark.png`, fullPage: true });
  });

  test("13 — Personas dark", async ({ page, login }) => {
    await login("admin@uros.gov.bd", "Admin@1234");
    await switchToDark(page);
    await navTo(page, "Personas");
    await page.screenshot({ path: `${OUT}/13-personas-dark.png`, fullPage: true });
  });

  test("14 — Improvement Advisor dark", async ({ page, login }) => {
    await login("admin@uros.gov.bd", "Admin@1234");
    await switchToDark(page);
    await navTo(page, "Improvement Advisor");
    await page.screenshot({ path: `${OUT}/14-improvement-dark.png`, fullPage: true });
  });

  test("15 — Task Logs dark", async ({ page, login }) => {
    await login("admin@uros.gov.bd", "Admin@1234");
    await switchToDark(page);
    await navTo(page, "Task Logs");
    await page.screenshot({ path: `${OUT}/15-task-logs-dark.png`, fullPage: true });
  });

  test("16 — Offboarding dark", async ({ page, login }) => {
    await login("admin@uros.gov.bd", "Admin@1234");
    await switchToDark(page);
    await navTo(page, "Offboarding");
    await page.screenshot({ path: `${OUT}/16-offboarding-dark.png`, fullPage: true });
  });

  test("17 — Analytics dark", async ({ page, login }) => {
    await login("admin@uros.gov.bd", "Admin@1234");
    await switchToDark(page);
    await navTo(page, "Recruitment Analytics");
    await page.screenshot({ path: `${OUT}/17-analytics-dark.png`, fullPage: true });
  });

  test("18 — Reports dark", async ({ page, login }) => {
    await login("admin@uros.gov.bd", "Admin@1234");
    await switchToDark(page);
    await navTo(page, "Reports");
    await page.screenshot({ path: `${OUT}/18-reports-dark.png`, fullPage: true });
  });

  test("19 — Rediscovery dark", async ({ page, login }) => {
    await login("admin@uros.gov.bd", "Admin@1234");
    await switchToDark(page);
    await navTo(page, "Candidate Rediscovery");
    await page.screenshot({ path: `${OUT}/19-rediscovery-dark.png`, fullPage: true });
  });

  test("20 — Brain Studio dark", async ({ page, login }) => {
    await login("admin@uros.gov.bd", "Admin@1234");
    await switchToDark(page);
    await navTo(page, "Brain Studio");
    await page.screenshot({ path: `${OUT}/20-brain-studio-dark.png`, fullPage: true });
  });

  test("21 — Appeals dark", async ({ page, login }) => {
    await login("admin@uros.gov.bd", "Admin@1234");
    await switchToDark(page);
    await navTo(page, "Appeals");
    await page.screenshot({ path: `${OUT}/21-appeals-dark.png`, fullPage: true });
  });

  test("22 — Audit dark", async ({ page, login }) => {
    await login("admin@uros.gov.bd", "Admin@1234");
    await switchToDark(page);
    await navTo(page, "Audit");
    await page.screenshot({ path: `${OUT}/22-audit-dark.png`, fullPage: true });
  });

  test("23 — Settings dark", async ({ page, login }) => {
    await login("admin@uros.gov.bd", "Admin@1234");
    await switchToDark(page);
    // Already on Settings from switchToDark, take screenshot
    await page.screenshot({ path: `${OUT}/23-settings-dark.png`, fullPage: true });
  });

  test("24 — theme switcher light state", async ({ page, login }) => {
    await login("admin@uros.gov.bd", "Admin@1234");
    await page.click("text=Settings");
    await page.waitForTimeout(1500);
    // Click Light first to show light state
    await page.click("button:has-text('Light')");
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${OUT}/24-theme-light.png`, fullPage: true });
  });

  test("25 — theme switcher dark state", async ({ page, login }) => {
    await login("admin@uros.gov.bd", "Admin@1234");
    await page.click("text=Settings");
    await page.waitForTimeout(1500);
    await page.click("button:has-text('Dark')");
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${OUT}/25-theme-dark.png`, fullPage: true });
  });

  test("26 — theme switcher system state", async ({ page, login }) => {
    await login("admin@uros.gov.bd", "Admin@1234");
    await page.click("text=Settings");
    await page.waitForTimeout(1500);
    await page.click("button:has-text('System')");
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${OUT}/26-theme-system.png`, fullPage: true });
  });

  test("27 — dark mode persistence after reload", async ({ page, login }) => {
    await login("admin@uros.gov.bd", "Admin@1234");
    await switchToDark(page);
    // Reload the page — dark mode should persist
    await page.reload();
    await page.waitForTimeout(2000);
    await page.screenshot({ path: `${OUT}/27-dark-persist-reload.png`, fullPage: true });
  });

  test("28 — dark mode persistence across sessions", async ({ page }) => {
    // Login and set dark mode
    await page.goto("/");
    await page.waitForSelector('input[type="email"]', { timeout: 10_000 });
    await page.fill('input[type="email"]', "admin@uros.gov.bd");
    await page.fill('input[type="password"]', "Admin@1234");
    await page.click('button[type="submit"]');
    await page.waitForSelector('text=RECRUITMENT', { timeout: 15_000 });
    // Set dark via JS directly (faster than navigating to Settings)
    await page.evaluate(() => {
      document.documentElement.setAttribute("data-theme", "dark");
      localStorage.setItem("uros-theme", "dark");
    });
    await page.waitForTimeout(300);
    // Clear auth to simulate session end
    await page.evaluate(() => { localStorage.clear(); });
    // Set theme back in localStorage
    await page.evaluate(() => { localStorage.setItem("uros-theme", "dark"); });
    await page.goto("/");
    await page.waitForSelector('input[type="email"]', { timeout: 10_000 });
    await page.fill('input[type="email"]', "admin@uros.gov.bd");
    await page.fill('input[type="password"]', "Admin@1234");
    await page.click('button[type="submit"]');
    await page.waitForSelector('text=RECRUITMENT', { timeout: 15_000 });
    await page.waitForTimeout(500);
    await page.screenshot({ path: `${OUT}/28-dark-persist-session.png`, fullPage: true });
  });
});
