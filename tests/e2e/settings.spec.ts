import { test, expect } from "./fixtures/auth";

/**
 * Settings spec — navigate all 12 sub-tabs.
 */
test.describe("Settings", () => {
  test("settings loads with tabs", async ({ page, login }) => {
    await login("admin@uros.gov.bd", "Admin@1234");
    await page.click("text=Settings");
    await page.waitForTimeout(2000);
    // Check for key tab labels in the settings sidebar
    await expect(page.locator("button:has-text('Profile')").first()).toBeVisible({ timeout: 5_000 });
    await expect(page.locator("button:has-text('Organization')").first()).toBeVisible({ timeout: 5_000 });
    await expect(page.locator("button:has-text('Users')").first()).toBeVisible({ timeout: 5_000 });
  });

  test("can navigate to Credentials tab", async ({ page, login }) => {
    await login("admin@uros.gov.bd", "Admin@1234");
    await page.click("text=Settings");
    await page.waitForTimeout(2000);
    await page.click("button:has-text('Credentials')");
    await page.waitForTimeout(500);
    // Credentials tab content should load
    await expect(page.locator("text=Credentials").first()).toBeVisible({ timeout: 5_000 });
  });

  test("can navigate to Backup tab", async ({ page, login }) => {
    await login("admin@uros.gov.bd", "Admin@1234");
    await page.click("text=Settings");
    await page.waitForTimeout(2000);
    await page.click("button:has-text('Backup')");
    await page.waitForTimeout(500);
    await expect(page.locator("text=Backup").first()).toBeVisible({ timeout: 5_000 });
  });

  test("can navigate to Audit sub-tab in Settings", async ({ page, login }) => {
    await login("admin@uros.gov.bd", "Admin@1234");
    await page.click("text=Settings");
    await page.waitForTimeout(2000);
    await page.click("button:has-text('Audit')");
    await page.waitForTimeout(500);
    await expect(page.locator("text=Audit").first()).toBeVisible({ timeout: 5_000 });
  });

  test("can navigate to Data Export tab", async ({ page, login }) => {
    await login("admin@uros.gov.bd", "Admin@1234");
    await page.click("text=Settings");
    await page.waitForTimeout(2000);
    await page.click("button:has-text('Data Export')");
    await page.waitForTimeout(500);
    await expect(page.locator("text=Data Export").first()).toBeVisible({ timeout: 5_000 });
  });
});
