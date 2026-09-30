import { test, expect } from "./fixtures/auth";

/**
 * Critical-path E2E: full recruitment flow from login through navigation.
 */
test.describe("Critical Path — Intake to Selected", () => {
  test("full recruitment flow", async ({ page, login }) => {
    // 1. Login
    await login("admin@uros.gov.bd", "Admin@1234");
    await expect(page.locator("text=Live Pipeline").first()).toBeVisible({ timeout: 10_000 });

    // 2. Navigate to Intake via sidebar
    await page.click("text=Intake");
    await page.waitForTimeout(1000);
    await expect(page.locator("text=Candidate Intake").first()).toBeVisible({ timeout: 10_000 });

    // 3. Verify CSV import sub-tab is visible
    await expect(page.locator("text=CV / CSV").first()).toBeVisible();

    // 4. Navigate to HIL Gates via sidebar
    await page.click("text=HIL Gates");
    await page.waitForTimeout(1000);
    await expect(page.locator("text=Human-in-the-Loop Gate Inbox").first()).toBeVisible({ timeout: 10_000 });

    // 5. Navigate to Brain Studio via sidebar
    await page.click("text=Brain Studio");
    await page.waitForTimeout(1000);
    await expect(page.locator("text=Brain Studio — Rule Pack Editor").first()).toBeVisible({ timeout: 10_000 });

    // 6. Navigate to Settings via sidebar
    await page.click("text=Settings");
    await page.waitForTimeout(2000);
    await expect(page.locator("button:has-text('Profile')").first()).toBeVisible({ timeout: 5_000 });

    // 7. Navigate to Audit via sidebar
    await page.click("text=Audit");
    await page.waitForTimeout(1000);
    // Audit stream should be visible on the right side panel
    await expect(page.locator("text=Audit Stream").first()).toBeVisible({ timeout: 10_000 });

    // 8. Navigate to Reports
    await page.click("text=Reports");
    await page.waitForTimeout(1000);
    await expect(page.locator("text=Report Generator").first()).toBeVisible({ timeout: 10_000 });

    // 9. Navigate to Recruitment Analytics
    await page.click("text=Recruitment Analytics");
    await page.waitForTimeout(1000);
    await expect(page.locator("text=Recruitment Analytics").first()).toBeVisible({ timeout: 10_000 });

    // 10. Navigate back to dashboard (recruitment)
    await page.click("text=Dashboard");
    await page.waitForTimeout(1000);
    await expect(page.locator("text=Live Pipeline").first()).toBeVisible({ timeout: 10_000 });
  });
});
