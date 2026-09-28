import { useMemo, useRef, useState } from "react";
import {
  useMcqResults,
  useMcqSheetDetail,
  useUploadMcqSheets,
  useReviewMcqSheet,
  McqSheetStatus,
} from "../hooks/hooks_mcq";
import { getToken } from "../api/client";
import { EmptyState } from "./EmptyState";

const STATUS_COLOR: Record<McqSheetStatus, string> = {
  UPLOADED: "text-text-secondary",
  PROCESSING: "text-agent",
  PROCESSED: "text-success",
  NEEDS_REVIEW: "text-attention",
  CONFIRMED: "text-success",
  REJECTED: "text-danger",
  RESCAN_REQUESTED: "text-human",
};

const STATUS_BADGE: Record<McqSheetStatus, string> = {
  UPLOADED: "bg-border-soft text-text-secondary",
  PROCESSING: "bg-agent text-white",
  PROCESSED: "bg-success text-white",
  NEEDS_REVIEW: "bg-attention text-white",
  CONFIRMED: "bg-success text-white",
  REJECTED: "bg-danger text-white",
  RESCAN_REQUESTED: "bg-human text-white",
};

function StatusBadge({ status }: { status: McqSheetStatus }) {
  return <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${STATUS_BADGE[status]}`}>{status.replace("_", " ")}</span>;
}

function SheetReviewDetail({ sheetId, examId, onClose }: { sheetId: string; examId: string | null; onClose: () => void }) {
  const { data, isLoading } = useMcqSheetDetail(sheetId);
  const review = useReviewMcqSheet(examId);
  const [reason, setReason] = useState("");
  const [rollNo, setRollNo] = useState("");
  const [pendingAction, setPendingAction] = useState<"CONFIRM" | "CORRECT" | "REJECT" | "RESCAN" | null>(null);
  const [corrections, setCorrections] = useState<Record<number, "A" | "B" | "C" | "D" | "E" | null>>({});

  if (isLoading || !data) return <EmptyState message="Loading sheet…" />;

  const { sheet, answers, result } = data;
  const flagged = answers.filter((a) => a.status === "LOW_CONFIDENCE" || a.status === "MULTIPLE_MARKS" || a.status === "MISSING");

  const submit = (action: "CONFIRM" | "CORRECT" | "REJECT" | "RESCAN") => {
    if (!reason.trim()) {
      setPendingAction(action);
      return;
    }
    const correctionList = Object.entries(corrections).map(([q, opt]) => ({ question_no: Number(q), corrected_option: opt }));
    review.mutate(
      {
        sheetId: sheet.sheet_id,
        action,
        reason: reason.trim(),
        rollNo: action === "CORRECT" && rollNo.trim() ? rollNo.trim() : undefined,
        corrections: action === "CORRECT" ? correctionList : undefined,
      },
      { onSuccess: () => onClose() }
    );
  };

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-border-soft bg-surface p-4">
      <div className="flex items-center justify-between">
        <div>
          <div className="text-sm font-medium text-text-primary">Sheet {sheet.sheet_id.slice(0, 8)}</div>
          <div className="text-xs text-text-secondary">
            Roll: {sheet.roll_no ?? "—"} · <StatusBadge status={sheet.status} />
          </div>
        </div>
        <button onClick={onClose} className="text-xs text-text-secondary">
          Close
        </button>
      </div>

      {/* Original image overlay — the human evidence panel */}
      <div className="overflow-hidden rounded-md border border-border-soft bg-background">
        <img
          src={`file://${sheet.file_path}`}
          alt="Original scanned sheet"
          className="max-h-64 w-full object-contain"
          onError={(e) => {
            (e.target as HTMLImageElement).style.display = "none";
          }}
        />
        <div className="px-2 py-1 text-[11px] text-text-secondary">{sheet.file_path}</div>
      </div>

      {sheet.processing_error && (
        <div className="rounded-md border border-danger bg-background px-2 py-1.5 text-xs text-danger">{sheet.processing_error}</div>
      )}

      {result && (
        <div className="grid grid-cols-4 gap-2 text-center text-xs">
          <div className="rounded bg-background p-2">
            <div className="text-text-secondary">Correct</div>
            <div className="text-sm font-medium text-success">{result.correct_count}</div>
          </div>
          <div className="rounded bg-background p-2">
            <div className="text-text-secondary">Wrong</div>
            <div className="text-sm font-medium text-danger">{result.wrong_count}</div>
          </div>
          <div className="rounded bg-background p-2">
            <div className="text-text-secondary">Skipped</div>
            <div className="text-sm font-medium text-text-primary">{result.skipped_count}</div>
          </div>
          <div className="rounded bg-background p-2">
            <div className="text-text-secondary">Final Score</div>
            <div className="text-sm font-medium text-agent">{result.final_score}</div>
          </div>
        </div>
      )}

      {flagged.length > 0 && (
        <div>
          <div className="mb-1 text-xs font-medium text-attention">Flagged answers ({flagged.length})</div>
          <table className="w-full text-left text-xs">
            <thead>
              <tr className="text-text-secondary">
                <th className="py-1 pr-2">Q#</th>
                <th className="py-1 pr-2">Detected</th>
                <th className="py-1 pr-2">Status</th>
                <th className="py-1 pr-2">Confidence</th>
                <th className="py-1">Correction</th>
              </tr>
            </thead>
            <tbody>
              {flagged.map((a) => (
                <tr key={a.sheet_answer_id} className="border-t border-border-soft">
                  <td className="py-1 pr-2 text-text-primary">{a.question_no}</td>
                  <td className="py-1 pr-2 text-text-secondary">{a.detected_option ?? "—"}</td>
                  <td className="py-1 pr-2 text-attention">{a.status.replace("_", " ")}</td>
                  <td className="py-1 pr-2 text-text-secondary">{a.confidence.toFixed(2)}</td>
                  <td className="py-1">
                    <select
                      value={corrections[a.question_no] ?? ""}
                      onChange={(e) =>
                        setCorrections((prev) => ({
                          ...prev,
                          [a.question_no]: (e.target.value || null) as "A" | "B" | "C" | "D" | "E" | null,
                        }))
                      }
                      className="rounded border border-border-soft bg-background px-1 py-0.5 text-xs"
                    >
                      <option value="">blank</option>
                      {["A", "B", "C", "D", "E"].map((o) => (
                        <option key={o} value={o}>
                          {o}
                        </option>
                      ))}
                    </select>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <input
            value={rollNo}
            onChange={(e) => setRollNo(e.target.value)}
            placeholder="Corrected roll no (optional)"
            className="flex-1 rounded-md border border-border-soft bg-background px-2 py-1.5 text-xs"
          />
        </div>
        <textarea
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="Mandatory reason for this review decision…"
          rows={2}
          className="rounded-md border border-border-soft bg-background px-2 py-1.5 text-xs"
        />
        {pendingAction && !reason.trim() && <div className="text-xs text-danger">A reason is required before {pendingAction}.</div>}
        <div className="flex flex-wrap gap-2">
          <button onClick={() => submit("CONFIRM")} className="rounded bg-human px-3 py-1.5 text-xs font-medium text-white">
            Confirm
          </button>
          <button onClick={() => submit("CORRECT")} className="rounded border border-attention px-3 py-1.5 text-xs font-medium text-attention">
            Apply Corrections
          </button>
          <button onClick={() => submit("REJECT")} className="rounded border border-danger px-3 py-1.5 text-xs font-medium text-danger">
            Reject
          </button>
          <button onClick={() => submit("RESCAN")} className="rounded border border-border-soft px-3 py-1.5 text-xs font-medium text-text-secondary">
            Request Rescan
          </button>
        </div>
      </div>
    </div>
  );
}

export function McqScannerPanel() {
  const [examId, setExamId] = useState("");
  const [activeExamId, setActiveExamId] = useState<string | null>(null);
  const [selectedSheetId, setSelectedSheetId] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const { data, isLoading, isError } = useMcqResults(activeExamId);
  const upload = useUploadMcqSheets(activeExamId);

  const statusCounts = useMemo(() => {
    const map: Partial<Record<McqSheetStatus, number>> = {};
    for (const row of data?.status_counts ?? []) map[row.status] = row.count;
    return map;
  }, [data]);

  if (!getToken()) return <EmptyState message="Connect with a dev token to use the MCQ scanner." />;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-2">
        <input
          value={examId}
          onChange={(e) => setExamId(e.target.value)}
          placeholder="Exam ID"
          className="flex-1 rounded-md border border-border-soft bg-surface px-3 py-1.5 text-sm text-text-primary"
        />
        <button onClick={() => setActiveExamId(examId.trim() || null)} className="rounded-md bg-agent px-3 py-1.5 text-xs font-medium text-white">
          Load Exam
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept=".jpg,.jpeg,.png,.pdf,.zip"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) upload.mutate(file);
            e.target.value = "";
          }}
        />
        <button
          disabled={!activeExamId || upload.isPending}
          onClick={() => fileInputRef.current?.click()}
          className="rounded-md bg-human px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50"
        >
          {upload.isPending ? "Uploading…" : "Upload Sheet(s)"}
        </button>
      </div>

      {!activeExamId && <EmptyState message="Enter an Exam ID and Load Exam to see the scanning queue and scorecard." />}
      {activeExamId && isLoading && <EmptyState message="Loading exam results…" />}
      {activeExamId && isError && <EmptyState message="Could not reach the MCQ API." tone="danger" />}
      {upload.isError && <EmptyState message={(upload.error as Error)?.message ?? "Upload failed."} tone="danger" />}

      {data && (
        <div className="flex flex-col gap-4">
          {/* Pipeline-style live status strip — no dead space */}
          <div className="flex flex-wrap gap-2">
            {(["UPLOADED", "PROCESSING", "PROCESSED", "NEEDS_REVIEW", "CONFIRMED", "REJECTED", "RESCAN_REQUESTED"] as McqSheetStatus[]).map(
              (status) => (
                <div key={status} className={`flex items-center gap-1.5 rounded-md border border-border-soft bg-surface px-2.5 py-1.5 text-xs ${STATUS_COLOR[status]}`}>
                  <span className="font-semibold">{statusCounts[status] ?? 0}</span>
                  <span className="text-text-secondary">{status.replace("_", " ")}</span>
                </div>
              )
            )}
          </div>

          {selectedSheetId ? (
            <SheetReviewDetail sheetId={selectedSheetId} examId={activeExamId} onClose={() => setSelectedSheetId(null)} />
          ) : data.results.length === 0 ? (
            <EmptyState message="No sheets uploaded yet for this exam. Click “Upload Sheet(s)”." />
          ) : (
            <div className="overflow-hidden rounded-lg border border-border-soft bg-surface">
              <table className="w-full text-left text-xs">
                <thead className="bg-background">
                  <tr className="text-text-secondary">
                    <th className="px-3 py-2">Roll No</th>
                    <th className="px-3 py-2">Status</th>
                    <th className="px-3 py-2">Correct</th>
                    <th className="px-3 py-2">Wrong</th>
                    <th className="px-3 py-2">Skipped</th>
                    <th className="px-3 py-2">Score</th>
                    <th className="px-3 py-2">Passed</th>
                    <th className="px-3 py-2"></th>
                  </tr>
                </thead>
                <tbody>
                  {data.results.map((row) => (
                    <tr key={row.sheet_id} className="border-t border-border-soft">
                      <td className="px-3 py-2 text-text-primary">{row.roll_no ?? "—"}</td>
                      <td className="px-3 py-2">
                        <StatusBadge status={row.sheet_status} />
                      </td>
                      <td className="px-3 py-2 text-success">{row.correct_count ?? "—"}</td>
                      <td className="px-3 py-2 text-danger">{row.wrong_count ?? "—"}</td>
                      <td className="px-3 py-2 text-text-secondary">{row.skipped_count ?? "—"}</td>
                      <td className="px-3 py-2 font-medium text-agent">{row.final_score ?? "—"}</td>
                      <td className="px-3 py-2">
                        {row.passed === null || row.passed === undefined ? "—" : row.passed ? (
                          <span className="text-success">Yes</span>
                        ) : (
                          <span className="text-danger">No</span>
                        )}
                      </td>
                      <td className="px-3 py-2">
                        <button onClick={() => setSelectedSheetId(row.sheet_id)} className="text-agent underline">
                          Review
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="flex items-center justify-between border-t border-border-soft px-3 py-2 text-[11px] text-text-secondary">
                <span>{data.count} sheet(s)</span>
                <a
                  href={`data:text/csv;charset=utf-8,${encodeURIComponent(
                    [
                      "roll_no,status,correct,wrong,skipped,final_score,passed",
                      ...data.results.map(
                        (r) => `${r.roll_no ?? ""},${r.sheet_status},${r.correct_count},${r.wrong_count},${r.skipped_count},${r.final_score},${r.passed ?? ""}`
                      ),
                    ].join("\n")
                  )}`}
                  download={`mcq-scorecard-${activeExamId}.csv`}
                  className="text-agent underline"
                >
                  Export Scorecard (CSV)
                </a>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
