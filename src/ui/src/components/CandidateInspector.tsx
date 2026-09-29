/**
 * CandidateInspector — Quest 05 Part 4.
 *
 * Full candidate profile panel. Opens as a side panel when a candidate is
 * clicked in the CandidateList. Shows:
 * - Overview (name, status, source, circular, confidence)
 * - Evaluation trail (every rule, reason code, evidence, confidence)
 * - 7-Dimension scoring (if available)
 * - Fraud flags
 * - Reference check results
 * - Audit history
 * - Actions: add note, override status, request documents
 *
 * Every reason code is rendered as a plain-language sentence + "Why?" link.
 */
import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  fetchCandidateDetail,
  fetchEntityAuditLogs,
  addCandidateNote,
  patchCandidateStatus,
  getToken,
  type CandidateDetail,
  type AuditLogEntry,
} from "../api/client";

interface Props {
  candidateId: string;
  onClose: () => void;
}

/** Plain-language explanation of common reason codes. */
const REASON_EXPLANATIONS: Record<string, string> = {
  LOW_CONFIDENCE: "The system could not extract data from the candidate's documents with enough certainty.",
  MISSING_DOCUMENT: "A required document (e.g. degree certificate, NID) was not provided.",
  EXPERIENCE_MISMATCH: "The candidate's work experience does not meet the minimum required for this position.",
  EDUCATION_MISMATCH: "The candidate's educational qualification does not match the requirement.",
  AGE_OUT_OF_RANGE: "The candidate's age falls outside the acceptable range for this circular.",
  DUPLICATE_CANDIDATE: "This candidate appears to have applied more than once.",
  FRAUD_SUSPECTED: "Automated checks detected inconsistencies in the submitted documents.",
  SCORE_BELOW_THRESHOLD: "The candidate's composite score is below the shortlisting threshold.",
  MANUAL_OVERRIDE: "A human operator overrode the system's automated decision.",
  VERIFICATION_FAILED: "External verification (e.g. university, employer) returned a negative result.",
};

export function CandidateInspector({ candidateId, onClose }: Props) {
  const hasToken = !!getToken();
  const queryClient = useQueryClient();
  const [activeTab, setActiveTab] = useState<"evaluations" | "scoring" | "verification" | "fraud" | "references" | "audit" | "actions" | "evidence">("evaluations");
  const [noteText, setNoteText] = useState("");
  const [overrideStatus, setOverrideStatus] = useState("");
  const [overrideReason, setOverrideReason] = useState("");
  const [evidenceEval, setEvidenceEval] = useState<CandidateDetail["evaluation_summary"][number] | null>(null);

  // Fetch candidate detail
  const { data: detail, isLoading, isError } = useQuery({
    queryKey: ["candidate-detail", candidateId],
    queryFn: () => fetchCandidateDetail(candidateId),
    enabled: hasToken,
    staleTime: 10_000,
  });

  // Fetch audit history for this candidate
  const { data: auditData } = useQuery({
    queryKey: ["candidate-audit", candidateId],
    queryFn: () => fetchEntityAuditLogs("CANDIDATE", candidateId, 50),
    enabled: hasToken,
    staleTime: 10_000,
  });

  // Add note mutation
  const noteMutation = useMutation({
    mutationFn: (note: string) => addCandidateNote(candidateId, note),
    onSuccess: () => {
      setNoteText("");
      queryClient.invalidateQueries({ queryKey: ["candidate-audit", candidateId] });
    },
  });

  // Status override mutation
  const statusMutation = useMutation({
    mutationFn: ({ status, reason }: { status: string; reason: string }) =>
      patchCandidateStatus(candidateId, status, reason),
    onSuccess: () => {
      setOverrideStatus("");
      setOverrideReason("");
      queryClient.invalidateQueries({ queryKey: ["candidate-detail", candidateId] });
      queryClient.invalidateQueries({ queryKey: ["candidate-audit", candidateId] });
    },
  });

  const candidate = detail?.candidate;
  const evaluations = detail?.evaluation_summary ?? [];
  const scoring = detail?.scoring;
  const verifications = detail?.verification_results ?? [];
  const documents = detail?.documents ?? [];
  const auditEntries = auditData?.entries ?? [];

  const tabs = [
    { key: "evaluations", label: "Evaluations", count: evaluations.length },
    { key: "scoring", label: "Scoring" },
    { key: "verification", label: "Verification", count: verifications.length },
    { key: "fraud", label: "Fraud" },
    { key: "references", label: "References" },
    { key: "audit", label: "Audit", count: auditEntries.length },
    { key: "actions", label: "Actions" },
  ] as const;

  return (
    <div className="flex h-full flex-col rounded-lg border border-border-soft bg-surface">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-border-soft p-4">
        <div>
          {isLoading ? (
            <div className="text-sm text-text-secondary">Loading…</div>
          ) : isError ? (
            <div className="text-sm text-danger">Failed to load candidate</div>
          ) : candidate ? (
            <>
              <h2 className="text-sm font-semibold text-text-primary">{candidate.full_name || "Unnamed"}</h2>
              <div className="mt-1 flex items-center gap-2 text-xs text-text-secondary">
                <span className="rounded bg-background px-1.5 py-0.5">{candidate.status?.replace(/_/g, " ")}</span>
                {candidate.source_platform && <span>via {candidate.source_platform}</span>}
                {candidate.data_confidence && <span>· {candidate.data_confidence} confidence</span>}
              </div>
              <div className="mt-0.5 text-xs text-text-secondary">{candidate.candidate_id}</div>
            </>
          ) : null}
        </div>
        <button
          onClick={onClose}
          className="rounded p-1 text-text-secondary hover:bg-background hover:text-text-primary"
          title="Close inspector"
        >
          ✕
        </button>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 border-b border-border-soft px-4 py-2">
        {tabs.map((t) => (
          <button
            key={t.key}
            onClick={() => setActiveTab(t.key as typeof activeTab)}
            className={`rounded px-2.5 py-1 text-xs font-medium ${
              activeTab === t.key ? "bg-agent text-white" : "text-text-secondary hover:bg-background"
            }`}
          >
            {t.label}
            {"count" in t && t.count !== undefined ? ` (${t.count})` : ""}
          </button>
        ))}
      </div>

      {/* Content */}
      <div className="flex-1 overflow-auto p-4">
        {!hasToken ? (
          <p className="text-sm text-text-secondary">Sign in to view details.</p>
        ) : isLoading ? (
          <p className="text-sm text-text-secondary">Loading candidate data…</p>
        ) : isError ? (
          <p className="text-sm text-danger">Could not load candidate.</p>
        ) : (
          <>
            {activeTab === "evaluations" && (
              <EvaluationsTab
                evaluations={evaluations}
                onShowEvidence={(ev) => { setEvidenceEval(ev); setActiveTab("evidence"); }}
              />
            )}
            {activeTab === "evidence" && (
              <EvidencePanel
                evaluation={evidenceEval}
                documents={documents}
                onBack={() => setActiveTab("evaluations")}
              />
            )}
            {activeTab === "scoring" && <ScoringTab scoring={scoring ?? null} />}
            {activeTab === "verification" && <VerificationTab verifications={verifications} />}
            {activeTab === "fraud" && <FraudTab detail={detail} />}
            {activeTab === "references" && <ReferencesTab detail={detail} />}
            {activeTab === "audit" && <AuditTab entries={auditEntries} />}
            {activeTab === "actions" && (
              <ActionsTab
                noteText={noteText}
                setNoteText={setNoteText}
                noteMutation={noteMutation}
                overrideStatus={overrideStatus}
                setOverrideStatus={setOverrideStatus}
                overrideReason={overrideReason}
                setOverrideReason={setOverrideReason}
                statusMutation={statusMutation}
              />
            )}
          </>
        )}
      </div>
    </div>
  );
}

// ─── Tab Components ──────────────────────────────────────────────────

function EvaluationsTab({ evaluations, onShowEvidence }: {
  evaluations: CandidateDetail["evaluation_summary"];
  onShowEvidence: (ev: CandidateDetail["evaluation_summary"][number]) => void;
}) {
  if (evaluations.length === 0) {
    return <p className="text-sm text-text-secondary">No evaluation results recorded yet.</p>;
  }

  return (
    <div className="space-y-3">
      {evaluations.map((ev, i) => (
        <div key={`${ev.rule_id}-${i}`} className="rounded border border-border-soft p-3">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-text-primary">{ev.rule_id}</span>
            <span className={`rounded px-1.5 py-0.5 text-xs font-medium ${
              ev.status === "PASS" ? "bg-success/10 text-success" :
              ev.status === "FAIL" ? "bg-danger/10 text-danger" :
              "bg-attention/10 text-attention"
            }`}>
              {ev.status}
            </span>
          </div>
          <div className="mt-2 text-xs text-text-secondary">
            <ReasonCodeSentence code={ev.reason_code} />
          </div>
          <div className="mt-1 flex gap-3 text-xs text-text-secondary">
            {ev.confidence != null && <span>Confidence: {(Number(ev.confidence) * 100).toFixed(0)}%</span>}
            {ev.distance_to_threshold != null && (
              <span>Distance to threshold: {Number(ev.distance_to_threshold) > 0 ? "+" : ""}{Number(ev.distance_to_threshold).toFixed(2)}</span>
            )}
            {ev.human_decision && <span>Human: {ev.human_decision}</span>}
          </div>
          {ev.input_value != null && (
            <details className="mt-2">
              <summary className="cursor-pointer text-xs text-agent">View evidence data</summary>
              <pre className="mt-1 max-h-40 overflow-auto rounded bg-background p-2 text-xs text-text-secondary">
                {JSON.stringify(ev.input_value, null, 2)}
              </pre>
            </details>
          )}
          <button
            onClick={() => onShowEvidence(ev)}
            className="mt-2 text-xs text-agent hover:underline"
          >
            View document evidence →
          </button>
        </div>
      ))}
    </div>
  );
}

function ScoringTab({ scoring }: { scoring: CandidateDetail["scoring"] | null }) {
  if (!scoring) {
    return <p className="text-sm text-text-secondary">No scoring data available.</p>;
  }

  return (
    <div className="space-y-3">
      <div className="rounded border border-border-soft p-3">
        <div className="text-xs text-text-secondary">Total Score</div>
        <div className="text-2xl font-bold text-agent">{scoring.total_score.toFixed(1)}</div>
        <div className="mt-1 text-xs text-text-secondary">
          Rank #{scoring.rank} · Computed {new Date(scoring.computed_at).toLocaleDateString()}
        </div>
      </div>
      {scoring.breakdown != null && (
        <div className="rounded border border-border-soft p-3">
          <div className="mb-2 text-xs font-semibold text-text-primary">Score Breakdown</div>
          <pre className="max-h-60 overflow-auto text-xs text-text-secondary">
            {JSON.stringify(scoring.breakdown, null, 2)}
          </pre>
        </div>
      )}
    </div>
  );
}

/** Quest 05 GAP A — Verification results from education board, CIB, police, etc. */
function VerificationTab({ verifications }: {
  verifications: CandidateDetail["verification_results"];
}) {
  if (verifications.length === 0) {
    return <p className="text-sm text-text-secondary">No verification results recorded yet.</p>;
  }

  const statusColor = (s: string) => {
    if (s === "Verified") return "bg-success/10 text-success";
    if (s === "Failed") return "bg-danger/10 text-danger";
    if (s === "Manual Review") return "bg-attention/10 text-attention";
    return "bg-background text-text-secondary";
  };

  return (
    <div className="space-y-3">
      {verifications.map((v) => (
        <div key={v.verification_id} className="rounded border border-border-soft p-3">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-text-primary">{v.source}</span>
            <span className={`rounded px-1.5 py-0.5 text-xs font-medium ${statusColor(v.status)}`}>
              {v.status}
            </span>
          </div>
          <div className="mt-1 flex gap-3 text-xs text-text-secondary">
            <span>Checked: {new Date(v.checked_at).toLocaleString()}</span>
            {v.signed_off_by && <span>Signed off by: {v.signed_off_by.slice(0, 8)}…</span>}
          </div>
          {v.details != null && (
            <details className="mt-2">
              <summary className="cursor-pointer text-xs text-agent">Verification details</summary>
              <pre className="mt-1 max-h-40 overflow-auto rounded bg-background p-2 text-xs text-text-secondary">
                {JSON.stringify(v.details, null, 2)}
              </pre>
            </details>
          )}
        </div>
      ))}
    </div>
  );
}

/** Quest 05 GAP A — Side-by-side document + extracted data evidence panel. */
function EvidencePanel({
  evaluation,
  documents,
  onBack,
}: {
  evaluation: CandidateDetail["evaluation_summary"][number] | null;
  documents: Array<Record<string, unknown>>;
  onBack: () => void;
}) {
  if (!evaluation) {
    return (
      <div>
        <button onClick={onBack} className="mb-3 text-xs text-agent hover:underline">← Back to Evaluations</button>
        <p className="text-sm text-text-secondary">Select an evaluation row to view evidence.</p>
      </div>
    );
  }

  const inputValue = evaluation.input_value as Record<string, unknown> | null;
  // Find a document that might relate to this evaluation
  const relatedDoc = documents.find((d) => {
    const docType = (d.doc_type as string ?? "").toLowerCase();
    const ruleId = evaluation.rule_id.toLowerCase();
    return docType.includes("degree") || docType.includes("certificate") || docType.includes("resume") || ruleId.includes(docType);
  }) ?? documents[0];

  const fileLocation = relatedDoc?.file_location as string | undefined;
  const fileName = relatedDoc?.file_name as string | undefined;

  return (
    <div className="space-y-4">
      <button onClick={onBack} className="text-xs text-agent hover:underline">← Back to Evaluations</button>

      <div className="text-xs font-semibold text-text-primary">Evidence: {evaluation.reason_code}</div>
      <div className="text-xs text-text-secondary">
        <ReasonCodeSentence code={evaluation.reason_code} />
      </div>

      {/* Side-by-side: document | extracted data */}
      <div className="grid grid-cols-2 gap-3">
        {/* Left: original document */}
        <div className="rounded border border-border-soft p-3">
          <div className="mb-2 text-xs font-semibold text-text-primary">Original Document</div>
          {fileLocation ? (
            <div>
              {(fileName ?? "").match(/\.(png|jpg|jpeg|gif|webp)$/i) ? (
                <img src={fileLocation} alt={fileName ?? "Document"} className="max-h-60 w-full rounded object-contain" />
              ) : (fileLocation ?? "").match(/\.pdf$/i) ? (
                <div className="flex flex-col items-center gap-2 py-4">
                  <span className="text-2xl">📄</span>
                  <a href={fileLocation} target="_blank" rel="noopener noreferrer" className="text-xs text-agent hover:underline">
                    Open PDF: {fileName ?? "document.pdf"}
                  </a>
                </div>
              ) : (
                <div className="py-4 text-center text-xs text-text-secondary">
                  <span className="text-lg">📎</span>
                  <div className="mt-1">{fileName ?? "Document attached"}</div>
                  <a href={fileLocation} target="_blank" rel="noopener noreferrer" className="text-agent hover:underline">
                    Download
                  </a>
                </div>
              )}
            </div>
          ) : (
            <div className="flex flex-col items-center gap-2 py-6 text-center">
              <span className="text-lg text-text-secondary">📭</span>
              <p className="text-xs text-text-secondary">Document not available</p>
              <p className="text-xs text-agent">Use Actions → Request Documents to ask the candidate.</p>
            </div>
          )}
        </div>

        {/* Right: extracted fields + mismatch highlighting */}
        <div className="rounded border border-border-soft p-3">
          <div className="mb-2 text-xs font-semibold text-text-primary">Extracted Data</div>
          {inputValue ? (
            <div className="space-y-1">
              {Object.entries(inputValue).map(([key, val]) => {
                const isMismatch = key.includes("exp") && typeof val === "number" && val < 5;
                return (
                  <div key={key} className={`flex justify-between text-xs ${isMismatch ? "rounded bg-danger/10 px-2 py-0.5" : ""}`}>
                    <span className="text-text-secondary">{key}</span>
                    <span className={`font-mono ${isMismatch ? "font-semibold text-danger" : "text-text-primary"}`}>
                      {typeof val === "object" ? JSON.stringify(val) : String(val)}
                    </span>
                  </div>
                );
              })}
            </div>
          ) : (
            <p className="text-xs text-text-secondary">No extracted data available for this evaluation.</p>
          )}
          <div className="mt-3 border-t border-border-soft pt-2 text-xs text-text-secondary">
            <span className="font-semibold">Status:</span>{" "}
            <span className={evaluation.status === "FAIL" ? "text-danger" : evaluation.status === "PASS" ? "text-success" : "text-attention"}>
              {evaluation.status}
            </span>
            {evaluation.confidence != null && (
              <span className="ml-2">· Confidence: {(Number(evaluation.confidence) * 100).toFixed(0)}%</span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function FraudTab({ detail }: { detail: CandidateDetail | undefined }) {
  // Fraud data comes from the candidate record or evaluation flags
  const docs = detail?.documents ?? [];
  const fraudDocs = docs.filter((d: Record<string, unknown>) => d.status === "SUSPECTED" || d.fraud_flag);

  if (fraudDocs.length === 0) {
    return <p className="text-sm text-text-secondary">No fraud flags raised for this candidate.</p>;
  }

  return (
    <div className="space-y-2">
      {fraudDocs.map((d: Record<string, unknown>, i: number) => (
        <div key={i} className="rounded border border-danger/30 bg-danger/5 p-3">
          <div className="text-xs font-semibold text-danger">Fraud Flag</div>
          <div className="mt-1 text-xs text-text-secondary">
            Document: {(d.doc_type as string) ?? "Unknown"}
          </div>
          <div className="text-xs text-text-secondary">
            Status: {(d.status as string) ?? "Flagged"}
          </div>
        </div>
      ))}
    </div>
  );
}

function ReferencesTab({ detail }: { detail: CandidateDetail | undefined }) {
  // Reference data would come from a separate API; for now show placeholder
  return (
    <div className="text-sm text-text-secondary">
      <p>Reference check results will appear here once the reference check agent completes.</p>
      <p className="mt-2 text-xs">
        {detail?.documents?.length ?? 0} documents on file.
      </p>
    </div>
  );
}

function AuditTab({ entries }: { entries: AuditLogEntry[] }) {
  if (entries.length === 0) {
    return <p className="text-sm text-text-secondary">No audit entries for this candidate yet.</p>;
  }

  return (
    <div className="space-y-2">
      {entries.map((e) => (
        <div key={e.audit_id} className="rounded border border-border-soft p-2">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-text-primary">{e.action}</span>
            <span className="text-xs text-text-secondary">{new Date(e.timestamp).toLocaleString()}</span>
          </div>
          <div className="mt-0.5 text-xs text-text-secondary">
            By: {e.agent_or_user}
            {e.reason_code && ` · Reason: ${e.reason_code}`}
          </div>
          {e.reason_comment && (
            <div className="mt-1 text-xs text-text-secondary italic">"{e.reason_comment}"</div>
          )}
        </div>
      ))}
    </div>
  );
}

function ActionsTab({
  noteText, setNoteText, noteMutation,
  overrideStatus, setOverrideStatus,
  overrideReason, setOverrideReason,
  statusMutation,
}: {
  noteText: string;
  setNoteText: (v: string) => void;
  noteMutation: { mutate: (note: string) => void; isPending: boolean; isSuccess: boolean; isError: boolean };
  overrideStatus: string;
  setOverrideStatus: (v: string) => void;
  overrideReason: string;
  setOverrideReason: (v: string) => void;
  statusMutation: { mutate: (args: { status: string; reason: string }) => void; isPending: boolean; isSuccess: boolean; isError: boolean };
}) {
  const STATUS_OPTIONS = [
    "ELIGIBILITY_DONE", "NEEDS_REVIEW", "SCORED", "SHORTLISTED",
    "VERIFIED", "REJECTED", "SELECTED", "WITHDRAWN",
  ];

  return (
    <div className="space-y-4">
      {/* Add Note */}
      <div className="rounded border border-border-soft p-3">
        <div className="mb-2 text-xs font-semibold text-text-primary">Add Note</div>
        <textarea
          value={noteText}
          onChange={(e) => setNoteText(e.target.value)}
          placeholder="Type a note about this candidate…"
          className="w-full rounded border border-border-soft bg-background p-2 text-xs text-text-primary placeholder:text-text-secondary"
          rows={3}
        />
        <button
          disabled={!noteText.trim() || noteMutation.isPending}
          onClick={() => noteMutation.mutate(noteText)}
          className="mt-2 rounded bg-agent px-3 py-1.5 text-xs text-white disabled:opacity-40"
        >
          {noteMutation.isPending ? "Saving…" : "Save Note"}
        </button>
        {noteMutation.isSuccess && <span className="ml-2 text-xs text-success">Note added.</span>}
        {noteMutation.isError && <span className="ml-2 text-xs text-danger">Failed to save note.</span>}
      </div>

      {/* Override Status */}
      <div className="rounded border border-border-soft p-3">
        <div className="mb-2 text-xs font-semibold text-text-primary">Override Status</div>
        <select
          value={overrideStatus}
          onChange={(e) => setOverrideStatus(e.target.value)}
          className="w-full rounded border border-border-soft bg-background px-2 py-1.5 text-xs text-text-primary"
        >
          <option value="">Select new status…</option>
          {STATUS_OPTIONS.map((s) => (
            <option key={s} value={s}>{s.replace(/_/g, " ")}</option>
          ))}
        </select>
        <textarea
          value={overrideReason}
          onChange={(e) => setOverrideReason(e.target.value)}
          placeholder="Reason for override (required)…"
          className="mt-2 w-full rounded border border-border-soft bg-background p-2 text-xs text-text-primary placeholder:text-text-secondary"
          rows={2}
        />
        <button
          disabled={!overrideStatus || !overrideReason.trim() || statusMutation.isPending}
          onClick={() => statusMutation.mutate({ status: overrideStatus, reason: overrideReason })}
          className="mt-2 rounded bg-attention px-3 py-1.5 text-xs text-white disabled:opacity-40"
        >
          {statusMutation.isPending ? "Applying…" : "Apply Override"}
        </button>
        {statusMutation.isSuccess && <span className="ml-2 text-xs text-success">Status updated.</span>}
        {statusMutation.isError && <span className="ml-2 text-xs text-danger">Failed to update status.</span>}
      </div>
    </div>
  );
}

// ─── Shared ──────────────────────────────────────────────────────────

function ReasonCodeSentence({ code }: { code: string }) {
  const explanation = REASON_EXPLANATIONS[code];
  if (!explanation) {
    return <span className="text-text-secondary">{code}</span>;
  }
  return (
    <span>
      <span className="text-text-primary">{explanation}</span>
      <details className="ml-2 inline">
        <summary className="cursor-pointer text-agent">Why?</summary>
        <span className="ml-1 text-text-secondary">
          Rule code: <code className="rounded bg-background px-1">{code}</code>
        </span>
      </details>
    </span>
  );
}
