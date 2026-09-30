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
      await page.click('button[type="submit"]');
      // Wait for dashboard content (SPA uses state-based nav, not URL)
      await page.waitForSelector('text=Live Pipeline', { timeout: 15_000 }).catch(async () => {
        // Fallback: wait for sidebar to appear
        await page.waitForSelector('text=RECRUITMENT', { timeout: 10_000 });
      });
    });
  },
  logout: async ({ page }, use) => {
    await use(async () => {
      await page.click('button:has-text("Sign out"), button:has-text("Sign Out"), button:has-text("Logout")');
      await page.waitForTimeout(1000);
    });
  },
});

export { expect };
