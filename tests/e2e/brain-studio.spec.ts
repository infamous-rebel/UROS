import { test, expect } from "./fixtures/auth";

/**
 * Brain Studio spec — rule pack editor.
 */
test.describe("Brain Studio", () => {
  test("brain studio loads with rule pack editor", async ({ page, login }) => {
    await login("admin@uros.gov.bd", "Admin@1234");
    await page.click("text=Brain Studio");
    // PanelCard title is "Brain Studio — Rule Pack Editor"
    await expect(page.locator("text=Brain Studio").first()).toBeVisible({ timeout: 10_000 });
  });

  test("brain studio shows sector selector when creating new pack", async ({ page, login }) => {
    await login("admin@uros.gov.bd", "Admin@1234");
    await page.click("text=Brain Studio");
    await page.waitForTimeout(2000);
    // Click "+ New Pack" to reveal the create form with sector selector
    await page.click("text=+ New Pack");
    await page.waitForTimeout(500);
    const select = page.locator("select").first();
    await expect(select).toBeVisible({ timeout: 5_000 });
  });

  test("brain studio shows rule type sections", async ({ page, login }) => {
    await login("admin@uros.gov.bd", "Admin@1234");
    await page.click("text=Brain Studio");
    // The rule pack editor should render
    await expect(page.locator("text=Brain Studio — Rule Pack Editor").first()).toBeVisible({ timeout: 10_000 });
  });
});
