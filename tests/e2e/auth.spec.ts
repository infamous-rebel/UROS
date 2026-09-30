import { test, expect } from "./fixtures/auth";

test.describe("Authentication", () => {
  test("login with valid credentials shows dashboard", async ({ page, login }) => {
    await login("admin@uros.gov.bd", "Admin@1234");
    await expect(page).toHaveURL(/dashboard/);
    await expect(page.locator("text=Pipeline")).toBeVisible();
  });

  test("login with wrong password shows error", async ({ page }) => {
    await page.goto("/");
    await page.fill('input[type="email"]', "admin@uros.gov.bd");
    await page.fill('input[type="password"]', "wrong-password");
    await page.click('button[type="submit"]');
    await expect(page.locator("text=Invalid credentials")).toBeVisible({ timeout: 5_000 });
  });

  test("logout clears session", async ({ page, login, logout }) => {
    await login("admin@uros.gov.bd", "Admin@1234");
    await expect(page).toHaveURL(/dashboard/);
    await logout();
    await expect(page).toHaveURL(/login/);
  });
});
