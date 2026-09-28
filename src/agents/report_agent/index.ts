import PDFDocument from "pdfkit";
import ExcelJS from "exceljs";
import { db } from "../../database/client";
import { logAudit } from "../../utils/audit_helper";
import { fetchAuditTrail, AuditTrailFilters } from "../audit_agent";

export type ReportType = "FUNNEL" | "SHORTLIST_SUMMARY" | "VERIFICATION_STATUS" | "AUDIT_LOGS";
export type ReportFormat = "json" | "pdf" | "excel" | "csv";

// ---------------------------------------------------------------------
// Data assembly — the same live queries reports.routes.ts already ran
// inline for the JSON format; extracted here as the single reusable
// source of truth so every format (json/pdf/excel/csv) renders from
// identical data, never from a second, divergent query.
// ---------------------------------------------------------------------

/** Funnel analysis: candidate count by pipeline status for a circular. */
export async function getFunnelData(circularId: string, orgId: string): Promise<Array<{ status: string; count: number }>> {
  const res = await db.query(
    `SELECT status, COUNT(*) AS count FROM candidates WHERE job_circular_id=$1 AND org_id=$2 GROUP BY status`,
    [circularId, orgId]
  );
  return res.rows.map((r: any) => ({ status: r.status, count: Number(r.count) }));
}

/** Shortlist summary: auto-pass/auto-fail/needs-review counts from the eligibility rule engine's own results. */
export async function getShortlistSummary(
  circularId: string,
  orgId: string
): Promise<{ auto_pass: number; auto_fail: number; needs_review: number }> {
  const res = await db.query(
    `SELECT
       COUNT(*) FILTER (WHERE er.status='PASS') AS auto_pass,
       COUNT(*) FILTER (WHERE er.status='FAIL') AS auto_fail,
       COUNT(*) FILTER (WHERE er.status='NEEDS_REVIEW') AS needs_review
     FROM evaluation_results er
     JOIN candidates c ON c.candidate_id = er.candidate_id
     WHERE c.job_circular_id=$1 AND c.org_id=$2`,
    [circularId, orgId]
  );
  const row = res.rows[0] ?? { auto_pass: 0, auto_fail: 0, needs_review: 0 };
  return { auto_pass: Number(row.auto_pass), auto_fail: Number(row.auto_fail), needs_review: Number(row.needs_review) };
}

/** Verification status: candidate count by verification outcome for a circular. */
export async function getVerificationStatus(circularId: string, orgId: string): Promise<Array<{ status: string; count: number }>> {
  const res = await db.query(
    `SELECT vr.status, COUNT(*) AS count
     FROM verification_results vr
     JOIN candidates c ON c.candidate_id = vr.candidate_id
     WHERE c.job_circular_id=$1 AND c.org_id=$2
     GROUP BY vr.status`,
    [circularId, orgId]
  );
  return res.rows.map((r: any) => ({ status: r.status, count: Number(r.count) }));
}

/** Audit log report — delegates entirely to the Audit Agent's read-only query function; no duplicate query logic here. */
export async function getAuditLogsReport(filters: AuditTrailFilters): Promise<Record<string, unknown>[]> {
  const { entries } = await fetchAuditTrail(filters);
  return entries as unknown as Record<string, unknown>[];
}

/** Resolves the row-set for a report type — used by both the JSON path and every binary renderer below, so they can never diverge. */
export async function getReportRows(
  type: ReportType,
  circularId: string,
  orgId: string,
  auditFilters?: AuditTrailFilters
): Promise<Record<string, unknown>[]> {
  switch (type) {
    case "FUNNEL":
      return getFunnelData(circularId, orgId);
    case "SHORTLIST_SUMMARY":
      return [await getShortlistSummary(circularId, orgId)];
    case "VERIFICATION_STATUS":
      return getVerificationStatus(circularId, orgId);
    case "AUDIT_LOGS":
      // NOTE (Security Hardening Round, known gap — not fixed in this
      // round): audit_log has no org_id column and fetchAuditTrail
      // does not filter by org; scoping this properly requires
      // threading org_id through logAudit() and every one of its ~30
      // call sites, which is a larger structural change than this
      // round's enumerated fixes. Tracked in progress.md.
      return getAuditLogsReport({ ...auditFilters, entity_id: auditFilters?.entity_id ?? circularId });
  }
}

// ---------------------------------------------------------------------
// Rendering — deterministic document generation, no ML/LLM. Every
// format renders the exact same rows returned by getReportRows above.
// ---------------------------------------------------------------------

/** Deterministic CSV rendering: headers from the first row's keys, RFC4180-style quoting. */
export function renderCsv(rows: Record<string, unknown>[]): Buffer {
  if (rows.length === 0) return Buffer.from("");
  const headers = Object.keys(rows[0]);
  const escape = (value: unknown) => {
    const s = value === null || value === undefined ? "" : String(value);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [headers.join(","), ...rows.map((row) => headers.map((h) => escape(row[h])).join(","))];
  return Buffer.from(lines.join("\n"), "utf-8");
}

/** Deterministic tabular PDF rendering via pdfkit. */
export function renderPdf(title: string, rows: Record<string, unknown>[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 50 });
    const chunks: Buffer[] = [];
    doc.on("data", (c: Buffer) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    doc.fontSize(16).text(title, { align: "center" });
    doc.moveDown(1);

    if (rows.length === 0) {
      doc.fontSize(11).text("No data available for this report.");
    } else {
      const headers = Object.keys(rows[0]);
      doc.fontSize(10).text(headers.join("  |  "), { underline: true });
      doc.moveDown(0.3);
      for (const row of rows) {
        doc.fontSize(9).text(headers.map((h) => String(row[h] ?? "")).join("  |  "));
      }
    }
    doc.end();
  });
}

/** Deterministic Excel rendering via exceljs. */
export async function renderExcel(title: string, rows: Record<string, unknown>[]): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet(title.slice(0, 31) || "Report"); // Excel sheet name limit

  if (rows.length > 0) {
    const headers = Object.keys(rows[0]);
    sheet.addRow(headers);
    sheet.getRow(1).font = { bold: true };
    for (const row of rows) {
      sheet.addRow(headers.map((h) => (row[h] === null || row[h] === undefined ? "" : (row[h] as any))));
    }
    sheet.columns.forEach((col) => {
      col.width = 20;
    });
  }

  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer);
}

// ---------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------

export interface GeneratedReport {
  type: ReportType;
  format: ReportFormat;
  contentType: string;
  filename: string;
  data: Record<string, unknown>[] | null; // set for format="json"
  buffer: Buffer | null; // set for pdf/excel/csv
}

/**
 * Generates a standard report in the requested format. Every format
 * renders from the exact same `getReportRows` data — this function
 * never queries directly, only assembles and renders. Every call is
 * audited (`REPORT_GENERATED`), matching the Master Feature Doc's
 * dashboard/report requirements and the Global Reasoning Standard's
 * "audit everything" rule.
 */
export async function generateReport(
  type: ReportType,
  circularId: string,
  format: ReportFormat,
  orgId: string,
  actor: string,
  auditFilters?: AuditTrailFilters
): Promise<GeneratedReport> {
  const rows = await getReportRows(type, circularId, orgId, auditFilters);
  const safeName = `${type.toLowerCase()}_${circularId.replace(/[^a-zA-Z0-9._-]/g, "_")}`;

  await logAudit({
    entity_type: "REPORT",
    entity_id: circularId,
    agent_or_user: actor,
    action: "REPORT_GENERATED",
    reason_code: "REPORT_GENERATED",
    reason_comment: `${type} report generated in ${format} format (${rows.length} row(s)).`,
    output_value: { type, format, row_count: rows.length },
  });

  if (format === "json") {
    return { type, format, contentType: "application/json", filename: `${safeName}.json`, data: rows, buffer: null };
  }
  if (format === "csv") {
    return { type, format, contentType: "text/csv", filename: `${safeName}.csv`, data: null, buffer: renderCsv(rows) };
  }
  if (format === "excel") {
    return {
      type,
      format,
      contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      filename: `${safeName}.xlsx`,
      data: null,
      buffer: await renderExcel(`${type} — ${circularId}`, rows),
    };
  }
  // pdf
  return {
    type,
    format,
    contentType: "application/pdf",
    filename: `${safeName}.pdf`,
    data: null,
    buffer: await renderPdf(`${type.replace("_", " ")} — ${circularId}`, rows),
  };
}
