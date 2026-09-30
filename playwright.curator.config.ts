import { defineConfig, devices } from "@playwright/test";

/**
 * Dedicated config for the screenshot curator.
 * The main playwright.config.ts ignores curator files via testIgnore
 * so they don't run in regular E2E suites. This config includes only them.
 */
export default defineConfig({
  testDir: "./tests/e2e",
  testMatch: "**/screenshot-curator.spec.ts",
  timeout: 180_000,
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 1 : 1,
  reporter: [["html", { open: "never" }], ["list"]],
  use: {
    baseURL: process.env.BASE_URL ?? "http://localhost:5173",
    trace: "on-first-retry",
    video: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
