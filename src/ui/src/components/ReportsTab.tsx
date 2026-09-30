/**
 * Quest 05 Part 8 — Reports tab: report selector, date range, filters,
 * live preview, and three DownloadButtons (PDF, Excel, CSV).
 */
import { useState } from "react";
import { API_V1, authedRequest, getToken } from "../api/client";
import { useI18n } from "../i18n";
import { DownloadButton } from "./DownloadButton";

type ReportType = "FUNNEL" | "SHORTLIST_SUMMARY" | "VERIFICATION_STATUS" | "AUDIT_LOGS";

const REPORT_TYPE_KEYS: { value: ReportType; labelKey: string }[] = [
  { value: "FUNNEL", labelKey: "reports.funnel" },
  { value: "SHORTLIST_SUMMARY", labelKey: "reports.shortlist" },
  { value: "VERIFICATION_STATUS", labelKey: "reports.verificationStatus" },
  { value: "AUDIT_LOGS", labelKey: "reports.auditLogs" },
];

export function ReportsTab() {
  const { t } = useI18n();
  const hasToken = !!getToken();
  const [reportType, setReportType] = useState<ReportType>("FUNNEL");
  const [circularId, setCircularId] = useState("");
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const [preview, setPreview] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function loadPreview() {
    if (!circularId) { setError(t("reports.circularRequired")); return; }
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
        <h3 className="text-sm font-semibold text-text-primary">{t("reports.generator")}</h3>
        <p className="text-xs text-text-secondary">{t("reports.subtitle")}</p>
      </div>

      {/* Report selector */}
      <div className="mb-4 grid grid-cols-2 gap-3">
        <div>
          <label className="mb-1 block text-xs font-medium text-text-primary">{t("reports.type")}</label>
          <select
            value={reportType}
            onChange={(e) => setReportType(e.target.value as ReportType)}
            className="w-full rounded border border-border-soft bg-background px-3 py-1.5 text-sm text-text-primary"
          >
            {REPORT_TYPE_KEYS.map((r) => (
              <option key={r.value} value={r.value}>{t(r.labelKey as any)}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium text-text-primary">{t("reports.circularId")}</label>
          <input
            value={circularId}
            onChange={(e) => setCircularId(e.target.value)}
            placeholder="e.g. circ-001"
            className="w-full rounded border border-border-soft bg-background px-3 py-1.5 text-sm text-text-primary"
          />
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium text-text-primary">{t("reports.from")}</label>
          <input type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)} className="w-full rounded border border-border-soft bg-background px-3 py-1.5 text-sm text-text-primary" />
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium text-text-primary">{t("reports.to")}</label>
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
          {loading ? t("reports.loading") : t("reports.preview")}
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
          <h4 className="mb-2 text-xs font-semibold text-text-primary">{t("reports.preview")} ({Array.isArray(preview.data) ? t("reports.rows", { count: preview.data.length }) : t("reports.summary")})</h4>
          <div className="max-h-64 overflow-auto">
            <pre className="text-xs text-text-secondary">{JSON.stringify(preview.data, null, 2)}</pre>
          </div>
        </div>
      )}

      {!preview && !error && (
        <div className="flex items-center justify-center rounded-lg border border-dashed border-border-soft py-12">
          <p className="text-sm text-text-secondary">{t("reports.emptyPrompt")}</p>
        </div>
      )}
    </div>
  );
}
