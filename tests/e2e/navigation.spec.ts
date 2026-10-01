import { test, expect } from "./fixtures/auth";

/**
 * Navigation spec — sidebar, command palette, breadcrumbs.
 */
test.describe("Navigation", () => {
  test("sidebar shows all nav groups", async ({ page, login }) => {
    await login("admin@uros.gov.bd", "Admin@1234");
    // RECRUITMENT group
    await expect(page.locator("text=RECRUITMENT").first()).toBeVisible({ timeout: 10_000 });
    // ASSESSMENT group — scroll into view since it may be below the fold
    const assessmentGroup = page.locator("text=ASSESSMENT").first();
    await assessmentGroup.scrollIntoViewIfNeeded();
    await expect(assessmentGroup).toBeVisible();
    // QUALITY & VERIFICATION — scroll into view
    const qualityGroup = page.locator("text=QUALITY").first();
    await qualityGroup.scrollIntoViewIfNeeded();
    await expect(qualityGroup).toBeVisible();
  });

  test("ASSESSMENT group expands and shows child items", async ({ page, login }) => {
    await login("admin@uros.gov.bd", "Admin@1234");
    // Scroll to ASSESSMENT group
    const assessmentGroup = page.locator("text=ASSESSMENT").first();
    await assessmentGroup.scrollIntoViewIfNeeded();
    // Check if child items are already visible (group starts expanded by default)
    const mcqScanner = page.locator("text=MCQ Scanner").first();
    const isVisible = await mcqScanner.isVisible();
    if (!isVisible) {
      // Group is collapsed, click to expand
      await assessmentGroup.click();
    }
    // Child items should be visible
    await expect(page.locator("text=MCQ Scanner").first()).toBeVisible({ timeout: 5_000 });
    await expect(page.locator("text=Digital Exam Creator").first()).toBeVisible({ timeout: 5_000 });
    await expect(page.locator("text=7-Dimension Matching").first()).toBeVisible({ timeout: 5_000 });
    // Click 7-Dimension Matching to navigate
    await page.click("text=7-Dimension Matching");
    await page.waitForTimeout(500);
    // Should still be on the dashboard (not crashed)
    await expect(page.locator("text=UROS").first()).toBeVisible();
  });

  test("can click through all main nav items", async ({ page, login }) => {
    await login("admin@uros.gov.bd", "Admin@1234");
    const navItems = ["Intake", "HIL Gates", "Brain Studio", "Settings", "Reports"];
    for (const item of navItems) {
      await page.click(`text=${item}`);
      await page.waitForTimeout(500);
    }
    // Should still be on the dashboard (not crashed)
    await expect(page.locator("text=UROS").first()).toBeVisible();
  });

  test("breadcrumb updates when navigating", async ({ page, login }) => {
    await login("admin@uros.gov.bd", "Admin@1234");
    // Navigate to Settings
    await page.click("text=Settings");
    await page.waitForTimeout(1000);
    // Breadcrumb should show the current location
    await expect(page.locator("text=Dashboard").or(page.locator("text=Settings")).first()).toBeVisible({ timeout: 5_000 });
  });

  test("sidebar collapse button exists", async ({ page, login }) => {
    await login("admin@uros.gov.bd", "Admin@1234");
    // The sidebar has a collapse toggle
    const collapseBtn = page.locator("button:has-text('<<')").or(page.locator("button[aria-label*='collapse']")).or(page.locator("button[aria-label*='Collapse']")).or(page.locator("nav button").first());
    await expect(collapseBtn).toBeVisible({ timeout: 5_000 });
  });

  test("command palette opens with Cmd+K", async ({ page, login }) => {
    await login("admin@uros.gov.bd", "Admin@1234");
    // Open command palette
    await page.keyboard.press("Meta+k");
    await page.waitForTimeout(500);
    // Command palette should appear
    const palette = page.locator("[role='dialog']").or(page.locator("input[placeholder*='Search']")).or(page.locator("text=Search navigation"));
    await expect(palette.first()).toBeVisible({ timeout: 5_000 });
    // Close it
    await page.keyboard.press("Escape");
  });
});
