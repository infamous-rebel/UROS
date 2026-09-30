import { test, expect } from "./fixtures/auth";

/**
 * Console-clean spec — navigate panels and assert no console errors.
 */
test.describe("Console Clean", () => {
  test("no console.error on dashboard load", async ({ page, login }) => {
    const errors: string[] = [];
    page.on("console", (msg) => {
      if (msg.type() === "error") errors.push(msg.text());
    });
    await login("admin@uros.gov.bd", "Admin@1234");
    await expect(page.locator("text=Live Pipeline")).toBeVisible({ timeout: 10_000 });
    await page.waitForTimeout(2000);
    // Filter out known benign errors
    const realErrors = errors.filter(
      (e) => !e.includes("favicon") && !e.includes("Failed to load resource") && !e.includes("net::ERR")
    );
    expect(realErrors).toEqual([]);
  });

  test("no console.error when navigating to Settings", async ({ page, login }) => {
    const errors: string[] = [];
    page.on("console", (msg) => {
      if (msg.type() === "error") errors.push(msg.text());
    });
    await login("admin@uros.gov.bd", "Admin@1234");
    await page.click("text=Settings");
    await page.waitForTimeout(2000);
    const realErrors = errors.filter(
      (e) => !e.includes("favicon") && !e.includes("Failed to load resource") && !e.includes("net::ERR")
    );
    expect(realErrors).toEqual([]);
  });

  test("no console.error when navigating to Reports", async ({ page, login }) => {
    const errors: string[] = [];
    page.on("console", (msg) => {
      if (msg.type() === "error") errors.push(msg.text());
    });
    await login("admin@uros.gov.bd", "Admin@1234");
    await page.click("text=Reports");
    await page.waitForTimeout(2000);
    const realErrors = errors.filter(
      (e) => !e.includes("favicon") && !e.includes("Failed to load resource") && !e.includes("net::ERR")
    );
    expect(realErrors).toEqual([]);
  });

  test("no uncaught promise rejections on dashboard", async ({ page, login }) => {
    const rejections: string[] = [];
    page.on("pageerror", (err) => {
      rejections.push(err.message);
    });
    await login("admin@uros.gov.bd", "Admin@1234");
    await expect(page.locator("text=Live Pipeline")).toBeVisible({ timeout: 10_000 });
    // Navigate through a few panels
    await page.click("text=Settings");
    await page.waitForTimeout(1000);
    await page.click("text=Reports");
    await page.waitForTimeout(1000);
    await page.click("text=Brain Studio");
    await page.waitForTimeout(1000);
    // Filter known benign
    const realRejections = rejections.filter(
      (r) => !r.includes("favicon") && !r.includes("Failed to load resource")
    );
    expect(realRejections).toEqual([]);
  });
});
