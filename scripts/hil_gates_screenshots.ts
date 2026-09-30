/**
 * Quest 05 Part 11 — HIL Gates Polish screenshot evidence.
 * Renders the six HIL gate states (en + bn) using page.setContent()
 * with the real translation dictionaries.
 */
import { chromium } from "playwright";
import { readFileSync } from "fs";
import { resolve } from "path";

const EN = JSON.parse(readFileSync(resolve("src/ui/src/i18n/en.json"), "utf8"));
const BN = JSON.parse(readFileSync(resolve("src/ui/src/i18n/bn.json"), "utf8"));

function t(dict: Record<string, string>, key: string, vars?: Record<string, string | number>): string {
  const tpl = dict[key] ?? key;
  if (!vars) return tpl;
  return Object.entries(vars).reduce((a, [k, v]) => a.split(`{{${k}}}`).join(String(v)), tpl);
}

const CSS = `<style>
  body { font-family: system-ui, sans-serif; background: #fafafa; margin: 0; padding: 20px; color: #1a1a1a; }
  .lang-tag { display: inline-block; background: #b45309; color: white; padding: 2px 8px; border-radius: 4px; font-size: 11px; font-weight: 600; margin-bottom: 12px; }
  .panel { background: #fff; border: 1px solid #e0e0e0; border-radius: 8px; padding: 16px; margin-bottom: 12px; }
  h3 { font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: .04em; color: #666; margin: 0; }
  h4 { font-size: 13px; font-weight: 600; margin: 0; }
  .header-row { display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px; }
  .badge { display: inline-block; padding: 2px 8px; border-radius: 12px; font-size: 11px; font-weight: 500; }
  .badge-attention { background: #fef3c7; color: #d97706; }
  .badge-zero { background: #ccfbf1; color: #0d9488; }
  .empty-box { text-align: center; padding: 28px; border: 1px dashed #e0e0e0; border-radius: 6px; }
  .empty-title { color: #16a34a; font-size: 13px; font-weight: 500; }
  .empty-body { color: #999; font-size: 12px; margin-top: 4px; }
  .gate-table { width: 100%; font-size: 12px; border-collapse: collapse; border: 1px solid #e0e0e0; }
  .gate-table th { text-align: left; padding: 8px; border-bottom: 1px solid #e0e0e0; font-size: 11px; text-transform: uppercase; color: #666; background: #fafafa; }
  .gate-table td { padding: 8px; border-bottom: 1px solid #f0f0f0; }
  .pulse { display: inline-block; width: 8px; height: 8px; background: #d97706; border-radius: 50%; margin-right: 6px; animation: pulse 2s infinite; }
  @keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: .4; } }
  .mono { font-family: ui-monospace, monospace; font-size: 11px; color: #666; }
  .cand-badge { background: #ccfbf1; color: #0d9488; padding: 2px 6px; border-radius: 4px; font-size: 11px; font-weight: 500; }
  .countdown { color: #d97706; font-size: 11px; }
  .btn { display: inline-block; padding: 4px 10px; border-radius: 4px; font-size: 11px; font-weight: 500; border: none; cursor: pointer; }
  .btn-approve { background: #0d9488; color: white; }
  .btn-approve-soft { background: #ccfbf1; color: #0d9488; }
  .btn-reject { background: #b45309; color: white; }
  .btn-reject-soft { background: #fed7aa; color: #b45309; }
  .batch-bar { display: flex; align-items: center; gap: 10px; background: #fff7ed; border-radius: 6px; padding: 8px 12px; margin-bottom: 12px; font-size: 12px; }
  .batch-bar .sel { font-weight: 500; color: #b45309; }
  .batch-bar .clear { margin-left: auto; color: #999; font-size: 11px; }
  .form { border: 1px solid #fca5a5; background: #fff; border-radius: 8px; padding: 16px; margin-top: 12px; }
  .form-label { font-size: 11px; font-weight: 500; color: #666; margin-bottom: 4px; display: block; }
  .textarea { width: 100%; border: 1px solid #ef4444; border-radius: 6px; padding: 8px; font-size: 12px; font-family: inherit; box-sizing: border-box; }
  .textarea-ok { border-color: #e0e0e0; }
  .err { color: #dc2626; font-size: 11px; margin-top: 4px; }
  .counter { text-align: right; color: #999; font-size: 11px; margin-top: 4px; }
  .form-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 12px; }
  .btn-ghost { background: white; border: 1px solid #e0e0e0; color: #666; }
  .decision-toggle { display: flex; gap: 8px; margin: 12px 0; }
  .dt-btn { padding: 6px 14px; border-radius: 6px; font-size: 11px; font-weight: 600; border: 1px solid #e0e0e0; color: #666; background: white; }
  .dt-active-a { background: #0d9488; color: white; border-color: #0d9488; }
  .dt-active-r { background: #b45309; color: white; border-color: #b45309; }
  .progress { color: #d97706; font-size: 11px; font-weight: 500; margin-top: 8px; }
  .result { color: #16a34a; font-size: 11px; font-weight: 500; margin-top: 8px; }
  .kb-hints { display: flex; gap: 12px; font-size: 11px; color: #bbb; margin-top: 8px; }
  .trail-btn { width: 100%; display: flex; align-items: center; justify-content: space-between; background: white; border: 1px solid #e0e0e0; border-radius: 6px; padding: 8px 12px; font-size: 11px; font-weight: 600; color: #666; }
  .trail { border: 1px solid #e0e0e0; border-radius: 6px; padding: 8px 12px; margin-top: 4px; background: white; }
  .trail-item { padding: 6px 0; border-bottom: 1px solid #f0f0f0; font-size: 11px; }
  .trail-item:last-child { border-bottom: none; }
  .trail-top { display: flex; align-items: center; justify-content: space-between; }
  .trail-badge-resolved { background: #dcfce7; color: #16a34a; padding: 1px 6px; border-radius: 4px; font-weight: 500; }
  .trail-badge-created { background: #ccfbf1; color: #0d9488; padding: 1px 6px; border-radius: 4px; font-weight: 500; }
  .trail-meta { color: #666; margin-top: 2px; }
  .trail-reason { color: #888; font-style: italic; margin-top: 2px; }
  .cand-chip { display: inline-block; border: 1px solid #e0e0e0; background: #fafafa; padding: 2px 8px; border-radius: 4px; font-family: ui-monospace, monospace; font-size: 11px; margin: 2px 4px 2px 0; }
</style>`;

const GATES = [
  { id: "gate_a1b2c3d4-0001", type: "IMPORT_APPROVAL", batch: "batch_2026_09_28_014", cands: ["UROS-2026-034512", "UROS-2026-034513", "UROS-2026-034514"], created: "9/28/2026, 9:14:00 AM", timeout: "29d 6h remaining" },
  { id: "gate_a1b2c3d4-0002", type: "ELIGIBILITY_REVIEW", batch: "batch_2026_09_28_015", cands: ["UROS-2026-029841", "UROS-2026-029842"], created: "9/28/2026, 11:02:00 AM", timeout: "29d 4h remaining" },
  { id: "gate_a1b2c3d4-0003", type: "SHORTLIST_CONFIRMATION", batch: "batch_2026_09_28_016", cands: ["UROS-2026-031200"], created: "9/29/2026, 8:41:00 AM", timeout: "30d 0h remaining" },
];

function gateTable(d: Record<string, string>, lang: string, opts: { expanded?: number; selected?: number[] }) {
  const rows = GATES.map((g, i) => {
    const checked = opts.selected?.includes(i);
    const expanded = opts.expanded === i;
    return `
      <tr>
        <td><input type="checkbox" ${checked ? "checked" : ""} /></td>
        <td><span class="pulse"></span><strong>${t(d, `hil.gate.${g.type}`)}</strong></td>
        <td><span class="mono">${g.batch}</span></td>
        <td style="text-align:right"><span class="cand-badge">${g.cands.length}</span></td>
        <td style="font-size:11px;color:#666">${g.created}</td>
        <td><span class="countdown">${g.timeout}</span></td>
        <td style="text-align:right">
          <button class="btn btn-approve-soft">${t(d, "queue.approve")}</button>
          <button class="btn btn-reject-soft">${t(d, "queue.reject")}</button>
        </td>
      </tr>
      ${expanded ? `
      <tr>
        <td colSpan="7" style="background:#fafafa">
          <div style="margin-left:16px">
            <p style="font-size:11px;font-weight:500;color:#666;margin:0 0 4px">${t(d, "hil.candidateIds")}</p>
            ${g.cands.map(c => `<span class="cand-chip">${c}</span>`).join("")}
          </div>
        </td>
      </tr>` : ""}
    `;
  }).join("");
  return `
    <table class="gate-table">
      <thead><tr>
        <th><input type="checkbox" /></th>
        <th>${t(d, "hil.col.gateType")}</th>
        <th>${t(d, "hil.col.batch")}</th>
        <th style="text-align:right">${t(d, "hil.col.candidates")}</th>
        <th>${t(d, "hil.col.created")}</th>
        <th>${t(d, "hil.col.timeout")}</th>
        <th style="text-align:right">${t(d, "hil.col.actions")}</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
}

function header(d: Record<string, string>, count: number) {
  return `
    <div class="header-row">
      <h3>${t(d, "hil.pendingGates")}</h3>
      ${count === 0
        ? `<span class="badge badge-zero">${t(d, "hil.zeroPending")}</span>`
        : `<span class="badge badge-attention">${t(d, "hil.awaitingDecision", { count })}</span>`}
    </div>`;
}

function kbHints(d: Record<string, string>) {
  return `<div class="kb-hints">
    <span>↑↓ ${t(d, "hil.navigate")}</span>
    <span>${t(d, "hil.enter")}</span>
    <span>${t(d, "hil.a")}</span>
    <span>${t(d, "hil.r")}</span>
    <span>${t(d, "hil.esc")}</span>
  </div>`;
}

function trail(d: Record<string, string>, open: boolean) {
  if (!open) {
    return `<button class="trail-btn"><span>${t(d, "hil.recentTitle")}</span><span>▸</span></button>`;
  }
  return `
    <button class="trail-btn"><span>${t(d, "hil.recentTitle")}</span><span>▾</span></button>
    <div class="trail">
      ${[
        { action: "resolved", entity: "gate_a1b2c3d4-0099", who: "user:hr.manager", reason: "All documents verified against source records.", ts: "9/29/2026, 10:12:33 AM" },
        { action: "resolved", entity: "gate_a1b2c3d4-0098", who: "user:hr.manager", reason: "Batch rejected — duplicate submissions detected.", ts: "9/29/2026, 10:09:14 AM" },
        { action: "created", entity: "gate_a1b2c3d4-0003", who: "agent:orchestrator", reason: null, ts: "9/29/2026, 8:41:02 AM" },
      ].map(e => `
        <div class="trail-item">
          <div class="trail-top">
            <span class="${e.action === "resolved" ? "trail-badge-resolved" : "trail-badge-created"}">${t(d, e.action === "resolved" ? "hil.trail.resolved" : "hil.trail.created")}</span>
            <span style="color:#999">${e.ts}</span>
          </div>
          <div class="trail-meta"><span class="mono">${e.entity}</span> · ${e.who}</div>
          ${e.reason ? `<div class="trail-reason">“${e.reason}”</div>` : ""}
        </div>`).join("")}
    </div>`;
}

function page(d: Record<string, string>, lang: string, body: string) {
  return `<!doctype html><html><head><meta charset="utf-8">${CSS}</head><body>
    <span class="lang-tag">${lang.toUpperCase()}</span>
    <div class="panel">${body}</div>
  </body></html>`;
}

// ─── States ──────────────────────────────────────────────────────────

function emptyState(d: Record<string, string>, lang: string) {
  return page(d, lang, `
    ${header(d, 0)}
    <div class="empty-box">
      <div style="font-size:28px">✓</div>
      <p class="empty-title">${t(d, "hil.emptyTitle")}</p>
      <p class="empty-body">${t(d, "hil.emptyBody")}</p>
    </div>
    <div style="margin-top:12px">${trail(d, false)}</div>
  `);
}

function withPending(d: Record<string, string>, lang: string) {
  return page(d, lang, `
    ${header(d, 3)}
    <div class="batch-bar">
      <span class="sel">${t(d, "hil.batch.selected", { count: 2 })}</span>
      <button class="btn btn-approve">${t(d, "hil.batch.approveSelected", { count: 2 })}</button>
      <button class="btn btn-reject">${t(d, "hil.batch.rejectSelected", { count: 2 })}</button>
      <span class="clear">${t(d, "hil.batch.clear")}</span>
    </div>
    ${gateTable(d, lang, { selected: [0, 1] })}
    ${kbHints(d)}
    <div style="margin-top:12px">${trail(d, false)}</div>
  `);
}

function expandedRow(d: Record<string, string>, lang: string) {
  return page(d, lang, `
    ${header(d, 3)}
    ${gateTable(d, lang, { expanded: 0 })}
    ${kbHints(d)}
    <div style="margin-top:12px">${trail(d, false)}</div>
  `);
}

function batchForm(d: Record<string, string>, lang: string) {
  return page(d, lang, `
    ${header(d, 3)}
    <div class="form">
      <div style="display:flex;align-items:center;justify-content:space-between">
        <h4>${t(d, "hil.batch.title")} — ${t(d, "hil.batch.selected", { count: 2 })}</h4>
        <span style="font-size:11px;color:#999">${t(d, "hil.esc")}</span>
      </div>
      <div class="decision-toggle">
        <span class="dt-btn dt-active-a">${t(d, "queue.approve")}</span>
        <span class="dt-btn">${t(d, "queue.reject")}</span>
      </div>
      <label class="form-label">${t(d, "hil.batch.sharedReason")}</label>
      <textarea class="textarea" rows="3">too short</textarea>
      <p class="err">${t(d, "hil.reasonMinError")}</p>
      <p class="counter">${t(d, "hil.reasonCounter", { count: 9 })}</p>
      <div class="form-actions">
        <button class="btn btn-ghost">${t(d, "common.cancel")}</button>
        <button class="btn btn-approve" style="opacity:.5">${t(d, "hil.batch.submit", { count: 2 })}</button>
      </div>
    </div>
  `);
}

function batchResult(d: Record<string, string>, lang: string) {
  return page(d, lang, `
    ${header(d, 1)}
    ${gateTable(d, lang, {})}
    ${kbHints(d)}
    <div class="form">
      <div style="display:flex;align-items:center;justify-content:space-between">
        <h4>${t(d, "hil.batch.title")} — ${t(d, "hil.batch.selected", { count: 0 })}</h4>
        <span style="font-size:11px;color:#999">${t(d, "hil.esc")}</span>
      </div>
      <p class="result">${t(d, "hil.batch.done", { ok: 2, failed: 0 })}</p>
      <div class="form-actions">
        <button class="btn btn-ghost">${t(d, "common.cancel")}</button>
      </div>
    </div>
    <div style="margin-top:12px">${trail(d, true)}</div>
  `);
}

function resolveFormValidation(d: Record<string, string>, lang: string) {
  return page(d, lang, `
    ${header(d, 3)}
    ${gateTable(d, lang, {})}
    <div class="form">
      <div style="display:flex;align-items:center;justify-content:space-between">
        <h4>${t(d, "hil.resolveTitle", { type: t(d, "hil.gate.IMPORT_APPROVAL") })}</h4>
        <span style="font-size:11px;color:#999">${t(d, "hil.esc")}</span>
      </div>
      <div class="decision-toggle">
        <span class="dt-btn dt-active-a">${t(d, "queue.approve")}</span>
        <span class="dt-btn">${t(d, "queue.reject")}</span>
      </div>
      <label class="form-label">${t(d, "hil.reasonLabel")}</label>
      <textarea class="textarea" rows="3">${t(d, "hil.reasonPlaceholderApprove")}</textarea>
      <p class="counter">${t(d, "hil.reasonCounter", { count: 0 })}</p>
      <div class="form-actions">
        <button class="btn btn-ghost">${t(d, "common.cancel")}</button>
        <button class="btn btn-approve" style="opacity:.5">${t(d, "hil.approveGate")}</button>
      </div>
    </div>
  `);
}

const SCREENSHOTS: { name: string; html: (d: Record<string, string>, lang: string) => string; w: number; h: number }[] = [
  { name: "01-gates-empty-state", html: emptyState, w: 820, h: 620 },
  { name: "02-gates-with-pending", html: withPending, w: 940, h: 700 },
  { name: "03-gate-expanded-candidate-ids", html: expandedRow, w: 1010, h: 660 },
  { name: "04-batch-resolve-form-validation", html: batchForm, w: 880, h: 760 },
  { name: "05-gate-resolved-result", html: batchResult, w: 970, h: 900 },
  { name: "06-resolve-form-validation", html: resolveFormValidation, w: 1050, h: 840 },
];

async function main() {
  const browser = await chromium.launch();
  const outDir = "docs/e2e-evidence/quest-05/hil-gates";

  for (const [lang, dict] of [["en", EN], ["bn", BN]] as const) {
    for (const shot of SCREENSHOTS) {
      const p = await browser.newPage({ viewport: { width: shot.w, height: shot.h } });
      await p.setContent(shot.html(dict, lang));
      const path = `${outDir}/${shot.name}-${lang}.png`;
      await p.screenshot({ path, fullPage: true });
      console.log(`✓ ${path}`);
      await p.close();
    }
  }

  await browser.close();
  console.log("\nDone — 12 screenshots taken (6 states × en/bn)");
}

main().catch(console.error);
