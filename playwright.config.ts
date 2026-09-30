import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  testIgnore: ["**/screenshot-curator.spec.ts", "**/dark-mode-curator.spec.ts"],
  timeout: 60_000,
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 2 : 1,
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
  webServer: [
    {
      command: "npm run dev",
      port: 3000,
      reuseExistingServer: true,
      timeout: 120_000,
    },
    {
      command: "cd src/ui && npx vite --port 5173",
      port: 5173,
      reuseExistingServer: true,
      timeout: 120_000,
    },
  ],
});
