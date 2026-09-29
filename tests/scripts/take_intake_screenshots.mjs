/**
 * Quest 05 Part 5 — Browser screenshots of all 4 intake panels.
 * Uses Playwright with the locally-installed Chromium.
 */
import { chromium } from "playwright";

const EVIDENCE_DIR = "docs/e2e-evidence/quest-05";
const UI_URL = "http://localhost:5173";
const API_URL = "http://localhost:3000";

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await context.newPage();

// Capture console logs for debugging
page.on('console', msg => console.log('BROWSER:', msg.type(), msg.text()));
page.on('pageerror', err => console.log('PAGE ERROR:', err.message));
page.on('request', req => {
  if (req.url().includes('/api/')) console.log('REQUEST:', req.method(), req.url(), '->', req.headers()['content-type'] ?? 'none');
});
page.on('response', res => {
  if (res.url().includes('/api/')) console.log('RESPONSE:', res.status(), res.url());
});

// Login via API to verify credentials
const loginRes = await fetch(`${API_URL}/api/v1/auth/login`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ email: "admin@uros.local", password: "Admin-Pass-123" }),
});
const { access_token } = await loginRes.json();
console.log("Login OK, token:", access_token.slice(0, 30) + "…");

// Navigate to UI
await page.goto(UI_URL, { waitUntil: "networkidle" });
console.log("Page loaded:", page.url());

// Login through the UI form (Vite proxy forwards /api to backend)
await page.fill('#login-email', 'admin@uros.local');
await page.fill('#login-password', 'Admin-Pass-123');
await page.click('button[type="submit"]');
await page.waitForTimeout(3000);
// Debug screenshot
await page.screenshot({ path: `${EVIDENCE_DIR}/debug-after-login.png` });
console.log("After login URL:", page.url());
console.log("Page title:", await page.title());

// Check for error messages
const errorMsg = await page.evaluate(() => {
  const el = document.querySelector('[role="alert"]');
  return el ? el.textContent : 'no error';
});
console.log("Error message:", errorMsg);

// Click the "Intake" tab in the dashboard — it's at the end of a scrollable tab bar
// Debug: log all button texts
const allButtonTexts = await page.evaluate(() => {
  return Array.from(document.querySelectorAll('button')).map(b => b.textContent.trim()).filter(t => t.length > 0);
});
console.log('All buttons:', allButtonTexts.join(', '));

// Scroll the tab bar to the right first
await page.evaluate(() => {
  const tabBar = document.querySelector('.flex.items-center.gap-1.border-b');
  if (tabBar) { tabBar.scrollLeft = tabBar.scrollWidth; console.log('scrolled tab bar'); }
  else { console.log('tab bar not found by class'); }
});
await page.waitForTimeout(500);
// Use JS click to bypass visibility check
await page.evaluate(() => {
  const buttons = document.querySelectorAll('button');
  for (const b of buttons) {
    if (b.textContent.includes('Intake')) { b.click(); return; }
  }
  throw new Error('Intake button not found. Buttons: ' + Array.from(buttons).map(b => b.textContent.trim()).filter(t => t).join(' | '));
});
await page.waitForTimeout(1000);

// 01 — Candidate Intake (CV/CSV sub-tab, default)
await page.screenshot({ path: `${EVIDENCE_DIR}/01-candidate-intake.png`, fullPage: true });
console.log("✓ 01-candidate-intake.png");

// 02 — Email Intake
await page.evaluate(() => {
  const buttons = document.querySelectorAll('button');
  for (const b of buttons) { if (b.textContent.trim() === 'Email') { b.click(); return; } }
});
await page.waitForTimeout(800);
await page.screenshot({ path: `${EVIDENCE_DIR}/02-email-intake.png`, fullPage: true });
console.log("✓ 02-email-intake.png");

// 03 — Bdjobs Panel (default tab: Session Scraper)
await page.evaluate(() => {
  const buttons = document.querySelectorAll('button');
  for (const b of buttons) { if (b.textContent.trim() === 'Bdjobs') { b.click(); return; } }
});
await page.waitForTimeout(800);
await page.screenshot({ path: `${EVIDENCE_DIR}/03-bdjobs-panel.png`, fullPage: true });
console.log("✓ 03-bdjobs-panel.png");

// 03a — Bdjobs Session Scraper (already default)
await page.screenshot({ path: `${EVIDENCE_DIR}/03a-bdjobs-session-scraper.png`, fullPage: true });
console.log("✓ 03a-bdjobs-session-scraper.png");

// 03b — Bdjobs CSV Import
await page.evaluate(() => {
  const buttons = document.querySelectorAll('button');
  for (const b of buttons) { if (b.textContent.trim() === 'CSV Import') { b.click(); return; } }
});
await page.waitForTimeout(500);
await page.screenshot({ path: `${EVIDENCE_DIR}/03b-bdjobs-csv-import.png`, fullPage: true });
console.log("✓ 03b-bdjobs-csv-import.png");

// 03c — Bdjobs Email Intake
await page.evaluate(() => {
  const buttons = document.querySelectorAll('button');
  for (const b of buttons) { if (b.textContent.trim() === 'Email Intake') { b.click(); return; } }
});
await page.waitForTimeout(500);
await page.screenshot({ path: `${EVIDENCE_DIR}/03c-bdjobs-email-intake.png`, fullPage: true });
console.log("✓ 03c-bdjobs-email-intake.png");

// 03d — Bdjobs ATS Webhook
await page.evaluate(() => {
  const buttons = document.querySelectorAll('button');
  for (const b of buttons) { if (b.textContent.trim() === 'ATS Webhook') { b.click(); return; } }
});
await page.waitForTimeout(500);
await page.screenshot({ path: `${EVIDENCE_DIR}/03d-bdjobs-webhook.png`, fullPage: true });
console.log("✓ 03d-bdjobs-webhook.png");

// 04 — Teletalk Panel
await page.evaluate(() => {
  const buttons = document.querySelectorAll('button');
  for (const b of buttons) { if (b.textContent.trim() === 'Teletalk') { b.click(); return; } }
});
await page.waitForTimeout(800);
await page.screenshot({ path: `${EVIDENCE_DIR}/04-teletalk-panel.png`, fullPage: true });
console.log("✓ 04-teletalk-panel.png");

await browser.close();
console.log("\nAll screenshots saved to", EVIDENCE_DIR);
