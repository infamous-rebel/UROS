/**
 * CandidateIntakePanel — Quest 05 Part 5.
 *
 * Drag-drop CV upload (PDF, DOCX, image) and CSV batch import with
 * column mapping UI, preview, validation errors, and import button.
 */
import { useState, useRef, useCallback } from "react";
import { getToken, API_V1 } from "../api/client";
import { DownloadButton } from "./DownloadButton";
import { getIcon } from "./navigation/iconRegistry";
import { Icon } from "./navigation/Icon";

interface ImportResult {
  batch_id: string;
  total: number;
  imported: number;
  failed: number;
  status: string;
}

export function CandidateIntakePanel() {
  const hasToken = !!getToken();
  const [mode, setMode] = useState<"cv" | "csv">("cv");
  const [uploading, setUploading] = useState(false);
  const [uploadResult, setUploadResult] = useState<string | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);

  // CSV state
  const [csvData, setCsvData] = useState<string[][] | null>(null);
  const [csvHeaders, setCsvHeaders] = useState<string[]>([]);
  const [columnMapping, setColumnMapping] = useState({ name: "", email: "", phone: "", dob: "" });
  const [circularId, setCircularId] = useState("");
  const [importResult, setImportResult] = useState<ImportResult | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const csvInputRef = useRef<HTMLInputElement>(null);

  const handleCvUpload = useCallback(async (file: File) => {
    if (!hasToken) return;
    setUploading(true);
    setUploadError(null);
    setUploadResult(null);

    const formData = new FormData();
    formData.append("file", file);

    try {
      const res = await fetch(`${API_V1}/intake/upload-cv`, {
        method: "POST",
        headers: { Authorization: `Bearer ${getToken()}` },
        body: formData,
      });
      const data = await res.json();
      if (!res.ok) {
        setUploadError(data.error ?? `Upload failed (HTTP ${res.status}). Reference: ${data.request_id ?? "N/A"}`);
      } else {
        setUploadResult(`CV "${data.file_name}" received. Candidate ${data.candidate_id} created in INTAKE queue.`);
      }
    } catch {
      setUploadError("Network error. Check your connection and try again.");
    } finally {
      setUploading(false);
    }
  }, [hasToken]);

  const handleCsvParse = useCallback((file: File) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const text = e.target?.result as string;
      const lines = text.split("\n").filter((l) => l.trim());
      if (lines.length < 2) {
        setUploadError("CSV must have a header row and at least one data row.");
        return;
      }
      const headers = lines[0].split(",").map((h) => h.trim().replace(/^"|"$/g, ""));
      const rows = lines.slice(1).map((l) => l.split(",").map((c) => c.trim().replace(/^"|"$/g, "")));
      setCsvHeaders(headers);
      setCsvData(rows);
      // Auto-map columns by name
      const autoMap = {
        name: headers.find((h) => /name|full.?name/i.test(h)) ?? "",
        email: headers.find((h) => /email/i.test(h)) ?? "",
        phone: headers.find((h) => /phone|mobile/i.test(h)) ?? "",
        dob: headers.find((h) => /dob|date.?of.?birth|birth/i.test(h)) ?? "",
      };
      setColumnMapping(autoMap);
      setUploadError(null);
    };
    reader.readAsText(file);
  }, []);

  const handleCsvImport = useCallback(async () => {
    if (!csvData || !circularId || !columnMapping.name) return;
    setUploading(true);
    setImportError(null);
    setImportResult(null);

    const rows = csvData.map((row) => {
      const obj: Record<string, string> = {};
      csvHeaders.forEach((h, i) => { obj[h] = row[i] ?? ""; });
      return obj;
    });

    try {
      const res = await fetch(`${API_V1}/intake/import-csv`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${getToken()}` },
        body: JSON.stringify({ circular_id: circularId, column_mapping: columnMapping, rows }),
      });
      const data = await res.json();
      if (!res.ok) {
        setImportError(data.error ?? `Import failed (HTTP ${res.status}).`);
      } else {
        setImportResult(data);
      }
    } catch {
      setImportError("Network error during import.");
    } finally {
      setUploading(false);
    }
  }, [csvData, csvHeaders, circularId, columnMapping]);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    const file = e.dataTransfer.files[0];
    if (!file) return;
    if (mode === "cv") handleCvUpload(file);
    else handleCsvParse(file);
  }, [mode, handleCvUpload, handleCsvParse]);

  return (
    <div className="space-y-4">
      {/* Mode toggle */}
      <div className="flex gap-2">
        <button
          onClick={() => setMode("cv")}
          className={`rounded px-3 py-1.5 text-xs font-medium ${mode === "cv" ? "bg-agent text-white" : "bg-background text-text-secondary"}`}
        >
          CV Upload
        </button>
        <button
          onClick={() => setMode("csv")}
          className={`rounded px-3 py-1.5 text-xs font-medium ${mode === "csv" ? "bg-agent text-white" : "bg-background text-text-secondary"}`}
        >
          CSV Batch Import
        </button>
      </div>

      {!hasToken ? (
        <p className="text-sm text-text-secondary">Sign in to upload candidates.</p>
      ) : mode === "cv" ? (
        /* ─── CV Upload ──────────────────────────────────────── */
        <div>
          <div
            onDrop={handleDrop}
            onDragOver={(e) => e.preventDefault()}
            onClick={() => fileInputRef.current?.click()}
            className="flex cursor-pointer flex-col items-center justify-center rounded-lg border-2 border-dashed border-border-soft bg-background py-8 transition-colors hover:border-agent"
          >
            <Icon icon={getIcon("File")} size={24} tone="neutral" />
            <p className="mt-2 text-sm text-text-primary">Drop a CV here or click to browse</p>
            <p className="text-xs text-text-secondary">PDF, DOCX, JPG, PNG — max 20 MB</p>
            <input
              ref={fileInputRef}
              type="file"
              accept=".pdf,.docx,.jpg,.jpeg,.png"
              className="hidden"
              onChange={(e) => { const f = e.target.files?.[0]; if (f) handleCvUpload(f); }}
            />
          </div>
          {uploading && <p className="mt-2 text-xs text-agent">Uploading…</p>}
          {uploadResult && <p className="mt-2 text-xs text-success">{uploadResult}</p>}
          {uploadError && <p className="mt-2 text-xs text-danger">{uploadError}</p>}
        </div>
      ) : (
        /* ─── CSV Import ─────────────────────────────────────── */
        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <span className="text-xs text-text-secondary">Need a template?</span>
            <DownloadButton endpoint={`${API_V1}/templates/candidates.csv`} format="csv" filename="candidates-template.csv" label="Download CSV Template" size="sm" />
          </div>
          {/* File picker */}
          <div
            onDrop={handleDrop}
            onDragOver={(e) => e.preventDefault()}
            onClick={() => csvInputRef.current?.click()}
            className="flex cursor-pointer flex-col items-center justify-center rounded-lg border-2 border-dashed border-border-soft bg-background py-6 transition-colors hover:border-agent"
          >
            <Icon icon={getIcon("BarChart3")} size={24} tone="neutral" />
            <p className="mt-2 text-sm text-text-primary">Drop a CSV file or click to browse</p>
            <input
              ref={csvInputRef}
              type="file"
              accept=".csv"
              className="hidden"
              onChange={(e) => { const f = e.target.files?.[0]; if (f) handleCsvParse(f); }}
            />
          </div>

          {/* Column mapping + preview */}
          {csvData && (
            <>
              <div className="rounded border border-border-soft p-3">
                <div className="mb-2 text-xs font-semibold text-text-primary">Column Mapping</div>
                <div className="grid grid-cols-2 gap-2">
                  {(["name", "email", "phone", "dob"] as const).map((field) => (
                    <div key={field} className="flex items-center gap-2">
                      <label className="w-16 text-xs text-text-secondary capitalize">{field}:</label>
                      <select
                        value={columnMapping[field]}
                        onChange={(e) => setColumnMapping((m) => ({ ...m, [field]: e.target.value }))}
                        className="flex-1 rounded border border-border-soft bg-background px-2 py-1 text-xs text-text-primary"
                      >
                        <option value="">— skip —</option>
                        {csvHeaders.map((h) => (
                          <option key={h} value={h}>{h}</option>
                        ))}
                      </select>
                    </div>
                  ))}
                </div>
              </div>

              {/* Preview */}
              <div className="rounded border border-border-soft p-3">
                <div className="mb-2 text-xs font-semibold text-text-primary">
                  Preview ({csvData.length} rows)
                </div>
                <div className="max-h-40 overflow-auto">
                  <table className="w-full text-left text-xs">
                    <thead>
                      <tr className="border-b border-border-soft text-text-secondary">
                        {csvHeaders.map((h) => <th key={h} className="pr-2">{h}</th>)}
                      </tr>
                    </thead>
                    <tbody>
                      {csvData.slice(0, 5).map((row, i) => (
                        <tr key={i} className="border-b border-border-soft last:border-0">
                          {row.map((c, j) => <td key={j} className="pr-2 text-text-secondary">{c}</td>)}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {csvData.length > 5 && <p className="mt-1 text-xs text-text-secondary">…and {csvData.length - 5} more rows</p>}
                </div>
              </div>

              {/* Circular ID + Import button */}
              <div className="flex items-center gap-3">
                <input
                  type="text"
                  placeholder="Circular ID (required)"
                  value={circularId}
                  onChange={(e) => setCircularId(e.target.value)}
                  className="flex-1 rounded border border-border-soft bg-background px-2 py-1.5 text-xs text-text-primary placeholder:text-text-secondary"
                />
                <button
                  disabled={!circularId || !columnMapping.name || uploading}
                  onClick={handleCsvImport}
                  className="rounded bg-agent px-4 py-1.5 text-xs text-white disabled:opacity-40"
                >
                  {uploading ? "Importing…" : `Import ${csvData.length} candidates`}
                </button>
              </div>
              {!columnMapping.name && <p className="text-xs text-attention">Map at least the "name" column to import.</p>}
            </>
          )}

          {importResult && (
            <div className="rounded border border-success/30 bg-success/5 p-3 text-xs">
              <p className="font-semibold text-success">Import complete</p>
              <p className="text-text-secondary">
                Batch {importResult.batch_id}: {importResult.imported} imported, {importResult.failed} failed out of {importResult.total}.
              </p>
            </div>
          )}
          {importError && <p className="text-xs text-danger">{importError}</p>}
          {uploadError && !csvData && <p className="text-xs text-danger">{uploadError}</p>}
        </div>
      )}
    </div>
  );
}
