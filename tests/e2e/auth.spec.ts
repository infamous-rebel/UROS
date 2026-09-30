import { test, expect } from "./fixtures/auth";

test.describe("Authentication", () => {
  test("login with valid credentials shows dashboard", async ({ page, login }) => {
    await login("admin@uros.gov.bd", "Admin@1234");
    // Dashboard should show pipeline strip
    await expect(page.locator("text=Live Pipeline")).toBeVisible();
    // Sidebar should show nav groups
    await expect(page.locator("text=RECRUITMENT").first()).toBeVisible();
  });

  test("login with wrong password shows error", async ({ page }) => {
    await page.goto("/");
    await page.fill('input[type="email"]', "admin@uros.gov.bd");
    await page.fill('input[type="password"]', "wrong-password");
    await page.click('button[type="submit"]');
    // PlainError shows status-based message for 401
    await expect(page.locator("text=session has expired").or(page.locator("text=Invalid")).first()).toBeVisible({ timeout: 10_000 });
  });

  test("logout clears session", async ({ page, login, logout }) => {
    await login("admin@uros.gov.bd", "Admin@1234");
    await expect(page.locator("text=Live Pipeline")).toBeVisible();
    await logout();
    // After logout, login form should reappear
    await expect(page.locator('input[type="email"]')).toBeVisible({ timeout: 10_000 });
  });
});
