/**
 * Quest 05 Part 8 — Reports tab: report selector, date range, filters,
 * live preview, and three DownloadButtons (PDF, Excel, CSV).
 */
import { useState } from "react";
import { API_V1, authedRequest, getToken } from "../api/client";
import { DownloadButton } from "./DownloadButton";

type ReportType = "FUNNEL" | "SHORTLIST_SUMMARY" | "VERIFICATION_STATUS" | "AUDIT_LOGS";

const REPORT_TYPES: { value: ReportType; label: string }[] = [
  { value: "FUNNEL", label: "Funnel Analysis" },
  { value: "SHORTLIST_SUMMARY", label: "Shortlist Summary" },
  { value: "VERIFICATION_STATUS", label: "Verification Status" },
  { value: "AUDIT_LOGS", label: "Audit Logs" },
];

export function ReportsTab() {
  const hasToken = !!getToken();
  const [reportType, setReportType] = useState<ReportType>("FUNNEL");
  const [circularId, setCircularId] = useState("");
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const [preview, setPreview] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function loadPreview() {
    if (!circularId) { setError("Circular ID is required for preview"); return; }
    setLoading(true);
    setError(null);
    try {
      const qs = new URLSearchParams({ type: reportType, circular_id: circularId, format: "json" });
      const res = await authedRequest<any>(`${API_V1}/reports/generate?${qs}`);
      setPreview(res);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  const qs = (format: string) => {
    const p = new URLSearchParams({ type: reportType, format, circular_id: circularId || "all" });
    if (fromDate) p.set("from", fromDate);
    if (toDate) p.set("to", toDate);
    return `${API_V1}/reports/generate?${p}`;
  };

  return (
    <div>
      <div className="mb-4">
        <h3 className="text-sm font-semibold text-text-primary">Report Generator</h3>
        <p className="text-xs text-text-secondary">Select a report type, set filters, and download in your preferred format.</p>
      </div>

      {/* Report selector */}
      <div className="mb-4 grid grid-cols-2 gap-3">
        <div>
          <label className="mb-1 block text-xs font-medium text-text-primary">Report Type</label>
          <select
            value={reportType}
            onChange={(e) => setReportType(e.target.value as ReportType)}
            className="w-full rounded border border-border-soft bg-background px-3 py-1.5 text-sm text-text-primary"
          >
            {REPORT_TYPES.map((r) => (
              <option key={r.value} value={r.value}>{r.label}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium text-text-primary">Circular ID</label>
          <input
            value={circularId}
            onChange={(e) => setCircularId(e.target.value)}
            placeholder="e.g. circ-001"
            className="w-full rounded border border-border-soft bg-background px-3 py-1.5 text-sm text-text-primary"
          />
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium text-text-primary">From</label>
          <input type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)} className="w-full rounded border border-border-soft bg-background px-3 py-1.5 text-sm text-text-primary" />
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium text-text-primary">To</label>
          <input type="date" value={toDate} onChange={(e) => setToDate(e.target.value)} className="w-full rounded border border-border-soft bg-background px-3 py-1.5 text-sm text-text-primary" />
        </div>
      </div>

      {/* Actions */}
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <button
          onClick={loadPreview}
          disabled={!hasToken || loading}
          className="rounded-md border border-border-soft px-3 py-1.5 text-xs font-medium text-text-secondary hover:bg-background disabled:opacity-50"
        >
          {loading ? "Loading…" : "Preview"}
        </button>

        <div className="ml-auto flex items-center gap-2">
          <DownloadButton endpoint={qs("pdf")} format="pdf" filename={`report-${reportType.toLowerCase()}.pdf`} label="PDF" size="sm" allowed={hasToken} />
          <DownloadButton endpoint={qs("excel")} format="xlsx" filename={`report-${reportType.toLowerCase()}.xlsx`} label="Excel" size="sm" allowed={hasToken} />
          <DownloadButton endpoint={qs("csv")} format="csv" filename={`report-${reportType.toLowerCase()}.csv`} label="CSV" size="sm" allowed={hasToken} />
        </div>
      </div>

      {error && <p className="mb-3 text-xs text-danger">{error}</p>}

      {/* Preview table */}
      {preview?.data && (
        <div className="rounded-lg border border-border-soft bg-background p-3">
          <h4 className="mb-2 text-xs font-semibold text-text-primary">Preview ({Array.isArray(preview.data) ? `${preview.data.length} rows` : "summary"})</h4>
          <div className="max-h-64 overflow-auto">
            <pre className="text-xs text-text-secondary">{JSON.stringify(preview.data, null, 2)}</pre>
          </div>
        </div>
      )}

      {!preview && !error && (
        <div className="flex items-center justify-center rounded-lg border border-dashed border-border-soft py-12">
          <p className="text-sm text-text-secondary">Select a report type and click Preview to see data.</p>
        </div>
      )}
    </div>
  );
}
