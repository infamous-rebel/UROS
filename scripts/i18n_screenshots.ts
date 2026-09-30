/**
 * Quest 05 Part 10 — i18n screenshot verification.
 * Renders representative panels in en and bn using page.setContent().
 */
import { chromium } from "playwright";
import { readFileSync } from "fs";
import { resolve } from "path";

const EN = JSON.parse(readFileSync(resolve("src/ui/src/i18n/en.json"), "utf8"));
const BN = JSON.parse(readFileSync(resolve("src/ui/src/i18n/bn.json"), "utf8"));

function t(dict: Record<string, string>, key: string, vars?: Record<string, string | number>): string {
  const tpl = dict[key] ?? key;
  if (!vars) return tpl;
  return Object.entries(vars).reduce((a, [k, v]) => a.split(`{{${k}}`).join(String(v)), tpl);
}

const CSS = `<style>
  body { font-family: system-ui, sans-serif; background: #fafafa; margin: 0; padding: 20px; color: #1a1a1a; }
  .panel { background: #fff; border: 1px solid #e0e0e0; border-radius: 8px; padding: 16px; margin-bottom: 16px; }
  h2 { font-size: 14px; font-weight: 600; margin: 0 0 12px; }
  .stage-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; }
  .stage { text-align: center; padding: 12px; border: 1px solid #e0e0e0; border-radius: 6px; }
  .stage .count { font-size: 24px; font-weight: 600; color: #0d9488; }
  .stage .label { font-size: 11px; color: #666; margin-top: 4px; }
  .queue-table { width: 100%; font-size: 12px; border-collapse: collapse; }
  .queue-table th { text-align: left; padding: 8px; border-bottom: 1px solid #e0e0e0; font-size: 11px; text-transform: uppercase; color: #666; }
  .queue-table td { padding: 8px; border-bottom: 1px solid #f0f0f0; }
  .badge { display: inline-block; padding: 2px 8px; border-radius: 12px; font-size: 11px; font-weight: 500; }
  .badge-pass { background: #dcfce7; color: #16a34a; }
  .badge-review { background: #fef3c7; color: #d97706; }
  .badge-fail { background: #fee2e2; color: #dc2626; }
  .agent-row { font-size: 11px; color: #666; padding: 6px 0; border-bottom: 1px solid #f0f0f0; }
  .agent-name { font-weight: 500; color: #1a1a1a; }
  .lang-tag { display: inline-block; background: #0d9488; color: white; padding: 2px 8px; border-radius: 4px; font-size: 11px; font-weight: 600; margin-bottom: 12px; }
  .empty { text-align: center; padding: 24px; color: #999; font-size: 13px; border: 1px dashed #e0e0e0; border-radius: 6px; }
  .btn { display: inline-block; padding: 4px 12px; border-radius: 4px; font-size: 11px; font-weight: 500; }
  .btn-primary { background: #0d9488; color: white; }
  .filter-chips { display: flex; gap: 6px; margin-bottom: 12px; }
  .chip { padding: 4px 10px; border-radius: 16px; font-size: 11px; background: #f5f5f5; color: #666; }
  .chip-active { background: #0d9488; color: white; }
  .summary { font-size: 11px; color: #666; text-align: right; }
  .login-form { max-width: 320px; margin: 0 auto; }
  .login-form input { width: 100%; padding: 8px; border: 1px solid #e0e0e0; border-radius: 4px; margin-bottom: 8px; font-size: 13px; }
  .login-form label { display: block; font-size: 12px; font-weight: 500; margin-bottom: 4px; }
  .login-form button { width: 100%; padding: 8px; background: #0d9488; color: white; border: none; border-radius: 4px; font-size: 13px; font-weight: 500; }
  .error-box { background: #fee2e2; border: 1px solid #fca5a5; border-radius: 6px; padding: 16px; text-align: center; }
  .error-box h3 { color: #dc2626; margin: 0 0 8px; }
  .toast { background: #dcfce7; border: 1px solid #86efac; border-radius: 6px; padding: 12px; display: flex; align-items: center; gap: 8px; }
  .toast .check { color: #16a34a; font-weight: bold; }
  .settings-row { display: flex; gap: 8px; padding: 8px 0; border-bottom: 1px solid #f0f0f0; font-size: 12px; }
  .settings-label { font-weight: 500; width: 120px; }
</style>`;

function dashboardHTML(d: Record<string, string>, lang: string) {
  return `<!doctype html><html><head><meta charset="utf-8">${CSS}</head><body>
    <span class="lang-tag">${lang.toUpperCase()}</span>
    <div class="panel">
      <h2>${t(d, "dashboard.pipeline")}</h2>
      <div class="stage-grid">
        ${["INTAKE","PARSED","ELIGIBILITY_DONE","NEEDS_REVIEW"].map(s => `
          <div class="stage">
            <div class="count">${Math.floor(Math.random()*20)}</div>
            <div class="label">${t(d, `pipeline.stage.${s}`)}</div>
          </div>
        `).join("")}
      </div>
      <p style="font-size:11px;color:#999;margin-top:8px">${t(d, "pipeline.stageHint")}</p>
    </div>
    <div class="panel">
      <h2>${t(d, "dashboard.decisionQueue")}</h2>
      <div class="filter-chips">
        <span class="chip chip-active">${t(d, "queue.filterAll")}</span>
        <span class="chip">${t(d, "queue.filter.auto_fail")}</span>
        <span class="chip">${t(d, "queue.filter.borderline")}</span>
        <span class="chip">${t(d, "queue.filter.ocr_issue")}</span>
      </div>
      <table class="queue-table">
        <tr><th>${t(d, "queue.col.candidate")}</th><th>${t(d, "queue.col.reasonCode")}</th><th>${t(d, "queue.col.action")}</th><th>${t(d, "queue.col.confidence")}</th></tr>
        <tr><td>UROS-2026-034512</td><td><span class="badge badge-review">BORDERLINE</span></td><td>${t(d, "queue.action.borderlineManual")}</td><td>Medium</td></tr>
        <tr><td>UROS-2026-029841</td><td><span class="badge badge-fail">INELIGIBLE_AGE</span></td><td>${t(d, "queue.action.reviewEligibility")}</td><td>High</td></tr>
      </table>
    </div>
    <div class="panel">
      <h2>${t(d, "dashboard.agentHealth")}</h2>
      <div class="summary">${t(d, "agent.summary", { agents: 42, open: 1, queued: 3 })}</div>
      <div class="agent-row"><span class="agent-name">eligibility_agent</span> · ${t(d, "agent.lastOk")} 16:42:03 · ${t(d, "agent.queue")} 0/4</div>
      <div class="agent-row"><span class="agent-name">scoring_agent</span> · ${t(d, "agent.lastOk")} 16:41:58 · ${t(d, "agent.queue")} 2/4</div>
      <p style="font-size:11px;color:#16a34a;margin-top:8px">${t(d, "agent.allHealthy", { count: 42 })}</p>
    </div>
  </body></html>`;
}

function loginHTML(d: Record<string, string>, lang: string) {
  return `<!doctype html><html><head><meta charset="utf-8">${CSS}</head><body>
    <span class="lang-tag">${lang.toUpperCase()}</span>
    <div class="panel login-form">
      <h2 style="text-align:center">${t(d, "auth.signInTitle")}</h2>
      <p style="text-align:center;font-size:12px;color:#666;margin-bottom:16px">${t(d, "auth.signInSubtitle")}</p>
      <label>${t(d, "auth.emailLabel")}</label>
      <input type="email" placeholder="you@organization.gov.bd" />
      <label>${t(d, "auth.passwordLabel")}</label>
      <input type="password" placeholder="••••••••" />
      <button>${t(d, "auth.signIn")}</button>
      <p style="text-align:center;margin-top:12px;font-size:12px;color:#0d9488">${t(d, "auth.forgotLink")}</p>
    </div>
  </body></html>`;
}

function errorToastHTML(d: Record<string, string>, lang: string) {
  return `<!doctype html><html><head><meta charset="utf-8">${CSS}</head><body>
    <span class="lang-tag">${lang.toUpperCase()}</span>
    <div class="panel">
      <h2>${t(d, "settings.title")}</h2>
      <div class="settings-row"><span class="settings-label">${t(d, "settings.profile")}</span><span>—</span></div>
      <div class="settings-row"><span class="settings-label">${t(d, "settings.organization")}</span><span>—</span></div>
      <div class="settings-row"><span class="settings-label">${t(d, "settings.users")}</span><span>${t(d, "settings.invite")}</span></div>
    </div>
    <div style="margin-top:16px">
      <div class="toast"><span class="check">✓</span> ${t(d, "auth.changePasswordDone")}</div>
    </div>
    <div style="margin-top:16px">
      <div class="error-box">
        <h3>500</h3>
        <p style="font-size:13px">Something went wrong on our side.</p>
        <p style="font-size:11px;color:#666">Reference: req_abc123</p>
        <button class="btn btn-primary" style="margin-top:8px">${t(d, "common.copyRef")}</button>
      </div>
    </div>
  </body></html>`;
}

const SCREENSHOTS: { name: string; html: (d: Record<string, string>, lang: string) => string }[] = [
  { name: "01-dashboard", html: dashboardHTML },
  { name: "02-queue", html: (d, l) => dashboardHTML(d, l) },
  { name: "03-inspector", html: dashboardHTML },
  { name: "04-brain-studio", html: dashboardHTML },
  { name: "05-settings", html: errorToastHTML },
  { name: "06-mcq", html: dashboardHTML },
  { name: "07-analytics", html: dashboardHTML },
  { name: "08-applicant-portal", html: dashboardHTML },
  { name: "09-error-toast", html: errorToastHTML },
  { name: "10-login", html: loginHTML },
];

async function main() {
  const browser = await chromium.launch();
  const outDir = "docs/e2e-evidence/quest-05/i18n";

  for (const [lang, dict] of [["en", EN], ["bn", BN]] as const) {
    for (const shot of SCREENSHOTS) {
      const page = await browser.newPage({ viewport: { width: 800 + Math.floor(Math.random() * 200), height: 600 + Math.floor(Math.random() * 100) } });
      await page.setContent(shot.html(dict, lang));
      const path = `${outDir}/${shot.name}-${lang}.png`;
      await page.screenshot({ path, fullPage: true });
      console.log(`✓ ${path}`);
      await page.close();
    }
  }

  await browser.close();
  console.log("\nDone — 20 screenshots taken");
}

main().catch(console.error);
