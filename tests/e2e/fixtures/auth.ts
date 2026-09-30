import { test as base, expect, type Page } from "@playwright/test";

export interface AuthFixture {
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
}

export const test = base.extend<AuthFixture>({
  login: async ({ page }, use) => {
    await use(async (email: string, password: string) => {
      await page.goto("/");
      await page.waitForSelector('input[type="email"]', { timeout: 10_000 });
      await page.fill('input[type="email"]', email);
      await page.fill('input[type="password"]', password);
      await page.click('button[type="submit"], button:has-text("Sign In"), button:has-text("Log In")');
      await page.waitForURL(/\/dashboard|\/#\/dashboard/, { timeout: 15_000 }).catch(() => {});
    });
  },
  logout: async ({ page }, use) => {
    await use(async () => {
      await page.click('button:has-text("Logout"), button:has-text("Sign Out")');
      await page.waitForURL(/\/login|\/#\/login/, { timeout: 10_000 }).catch(() => {});
    });
  },
});

export { expect };
