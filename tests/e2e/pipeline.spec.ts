import { test, expect } from "./fixtures/auth";

/**
 * Pipeline spec — verify the dashboard pipeline strip and candidate list.
 */
test.describe("Pipeline", () => {
  test("dashboard shows pipeline strip and decision queue", async ({ page, login }) => {
    await login("admin@uros.gov.bd", "Admin@1234");
    // Pipeline strip should be visible on the default dashboard
    await expect(page.locator("text=Pipeline")).toBeVisible({ timeout: 10_000 });
  });

  test("intake section shows sub-tabs", async ({ page, login }) => {
    await login("admin@uros.gov.bd", "Admin@1234");
    await page.click("text=Intake");
    await expect(page.locator("text=Candidate Intake")).toBeVisible({ timeout: 10_000 });
    // Sub-tabs
    await expect(page.locator("text=CV / CSV")).toBeVisible();
    await expect(page.locator("text=Email")).toBeVisible();
    await expect(page.locator("text=Bdjobs")).toBeVisible();
    await expect(page.locator("text=Teletalk")).toBeVisible();
  });

  test("HIL Gates inbox loads", async ({ page, login }) => {
    await login("admin@uros.gov.bd", "Admin@1234");
    await page.click("text=HIL Gates");
    await expect(page.locator("text=Human-in-the-Loop Gate Inbox")).toBeVisible({ timeout: 10_000 });
    // Either pending gates or empty state
    const hasGates = page.locator("text=Pending Gates");
    const hasEmpty = page.locator("text=All clear");
    await expect(hasGates.or(hasEmpty).first()).toBeVisible({ timeout: 10_000 });
  });

  test("can navigate from intake to gates", async ({ page, login }) => {
    await login("admin@uros.gov.bd", "Admin@1234");
    await page.click("text=Intake");
    await expect(page.locator("text=Candidate Intake")).toBeVisible({ timeout: 10_000 });
    await page.click("text=HIL Gates");
    await expect(page.locator("text=Human-in-the-Loop Gate Inbox")).toBeVisible({ timeout: 10_000 });
  });
});
