import { test, expect } from "@playwright/test";

/**
 * Critical-path E2E: full recruitment flow from INTAKE to SELECTED.
 * This is the single most important test in Quest 05.
 *
 * Requires: Postgres + Redis + API + UI running.
 * Run: npx playwright test tests/e2e/critical-path.spec.ts
 */
test.describe("Critical Path — Intake to Selected", () => {
  test("full recruitment flow", async ({ page }) => {
    // 1. Login
    await page.goto("/");
    await page.fill('input[type="email"]', "admin@uros.gov.bd");
    await page.fill('input[type="password"]', "Admin@1234");
    await page.click('button[type="submit"]');
    await expect(page).toHaveURL(/dashboard/);

    // 2. Navigate to Intake → CSV Import
    await page.click("text=Intake");
    await page.click("text=Candidate");
    await page.click("text=CSV Import");

    // 3. Upload CSV (5 candidates)
    const fileInput = page.locator('input[type="file"]');
    await fileInput.setInputFiles("tests/e2e/fixtures/sample_candidates.csv");
    await expect(page.locator("text=Import successful")).toBeVisible({ timeout: 30_000 });

    // 4. Verify candidates appear in list
    await page.click("text=Candidates");
    await expect(page.locator("text=UROS-2026-")).toHaveCount(5);

    // 5. Run eligibility screening
    await page.click("text=Brain Studio");
    await page.click("text=Run Pipeline");
    await expect(page.locator("text=Pipeline complete")).toBeVisible({ timeout: 60_000 });

    // 6. Check Decision Queue for results
    await page.click("text=Decision Queue");
    await expect(page.locator("tr")).toHaveCount(6); // header + 5 candidates

    // 7. Open HIL Gates tab
    await page.click("text=HIL Gates");
    const pendingBadge = page.locator("text=awaiting decision");
    await expect(pendingBadge).toBeVisible();

    // 8. Resolve first gate
    const firstGate = page.locator("tr").nth(1);
    await firstGate.click();
    await page.click("button:has-text('Approve')");
    await page.fill("textarea", "All candidates pass eligibility checks.");
    await page.click("button:has-text('Approve Gate')");
    await expect(page.locator("text=Gate resolved")).toBeVisible({ timeout: 10_000 });

    // 9. Verify final candidate status
    await page.click("text=Candidates");
    const selectedCandidate = page.locator("text=SELECTED").first();
    await expect(selectedCandidate).toBeVisible({ timeout: 30_000 });

    // 10. Verify audit trail
    await page.click("text=Audit");
    await expect(page.locator("text=GATE_RESOLVED")).toBeVisible();
    await expect(page.locator("text=CANDIDATE_CREATED")).toBeVisible();
  });
});
