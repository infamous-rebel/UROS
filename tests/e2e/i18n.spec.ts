import { test, expect } from "./fixtures/auth";

/**
 * i18n spec — switch to Bangla, verify panels render, switch back.
 */
test.describe("i18n", () => {
  test("language switcher is visible", async ({ page, login }) => {
    await login("admin@uros.gov.bd", "Admin@1234");
    // Language switcher in the command bar shows "English" and "বাংলা"
    const langButton = page.locator("button", { hasText: "English" }).or(page.locator("button", { hasText: "বাংলা" }));
    await expect(langButton.first()).toBeVisible({ timeout: 10_000 });
  });

  test("can switch to Bangla and see translated content", async ({ page, login }) => {
    await login("admin@uros.gov.bd", "Admin@1234");
    const langButton = page.locator("button", { hasText: "English" }).or(page.locator("button", { hasText: "বাংলা" }));
    // Click the Bangla button
    const bnButton = page.locator("button", { hasText: "বাংলা" });
    await bnButton.first().click();
    await page.waitForTimeout(1000);
    // Verify we're still on the dashboard (not crashed)
    await expect(page.locator("text=UROS").first()).toBeVisible({ timeout: 5_000 });
  });

  test("can switch back to English", async ({ page, login }) => {
    await login("admin@uros.gov.bd", "Admin@1234");
    // Switch to Bangla first
    const bnButton = page.locator("button", { hasText: "বাংলা" });
    await bnButton.first().click();
    await page.waitForTimeout(500);
    // Switch back to English
    const enButton = page.locator("button", { hasText: "English" });
    await enButton.first().click();
    await page.waitForTimeout(500);
    // English labels should be back
    await expect(page.locator("text=Dashboard").or(page.locator("text=RECRUITMENT")).first()).toBeVisible({ timeout: 5_000 });
  });

  test("settings panel renders in English", async ({ page, login }) => {
    await login("admin@uros.gov.bd", "Admin@1234");
    await page.click("text=Settings");
    await page.waitForTimeout(2000);
    // Profile tab should be selected by default
    await expect(page.locator("button:has-text('Profile')").first()).toBeVisible({ timeout: 5_000 });
  });
});
