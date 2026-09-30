import { useState, useEffect, useCallback, useRef } from "react";
import { usePendingGates, useResolveGate } from "../hooks/hooks_gates";
import { getToken, type GateSummary } from "../api/client";
import { getIcon } from "./navigation/iconRegistry";
import { Icon } from "./navigation/Icon";
import { useI18n } from "../i18n";

const GATE_TIMEOUT_MS = 1000 * 60 * 60 * 24 * 30; // 30 days — matches env.schema.ts

const GATE_TYPE_LABELS: Record<string, string> = {
  IMPORT_APPROVAL: "Import Approval",
  ELIGIBILITY_REVIEW: "Eligibility Review",
  SHORTLIST_CONFIRMATION: "Shortlist Confirmation",
  VERIFICATION_SIGNOFF: "Verification Sign-off",
  COMMUNICATION_APPROVAL: "Communication Approval",
  FINAL_APPROVAL: "Final Approval",
};

function formatCountdown(createdAt: string): string {
  const elapsed = Date.now() - new Date(createdAt).getTime();
  const remaining = Math.max(0, GATE_TIMEOUT_MS - elapsed);
  const days = Math.floor(remaining / (1000 * 60 * 60 * 24));
  const hours = Math.floor((remaining % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
  if (days > 0) return `${days}d ${hours}h remaining`;
  const mins = Math.floor((remaining % (1000 * 60 * 60)) / (1000 * 60));
  return `${hours}h ${mins}m remaining`;
}

function extractCandidateIds(payload: unknown): string[] {
  if (typeof payload !== "object" || payload === null) return [];
  const p = payload as Record<string, unknown>;
  if (Array.isArray(p.candidate_ids)) return p.candidate_ids.filter((x): x is string => typeof x === "string");
  return [];
}

export function HilGateInbox() {
  const { data, isLoading, isError } = usePendingGates();
  const resolveMutation = useResolveGate();
  const hasToken = !!getToken();
  const { t } = useI18n();

  const gates = data?.gates ?? [];
  const [expandedIdx, setExpandedIdx] = useState<number | null>(null);
  const [resolveIdx, setResolveIdx] = useState<number | null>(null);
  const [decision, setDecision] = useState<"APPROVE" | "REJECT">("APPROVE");
  const [reason, setReason] = useState("");
  const [resolveError, setResolveError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const reasonRef = useRef<HTMLTextAreaElement>(null);

  // Tick every 60s to refresh countdown timers
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 60_000);
    return () => clearInterval(id);
  }, []);

  // Focus reason textarea when resolve form opens
  useEffect(() => {
    if (resolveIdx !== null) {
      setTimeout(() => reasonRef.current?.focus(), 50);
    }
  }, [resolveIdx]);

  // Keyboard navigation
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (resolveIdx !== null) {
        if (e.key === "Escape") {
          setResolveIdx(null);
          setReason("");
          setResolveError(null);
          e.preventDefault();
        }
        return;
      }
      if (gates.length === 0) return;
      if (e.key === "ArrowDown") {
        setExpandedIdx((prev) => Math.min((prev ?? -1) + 1, gates.length - 1));
        e.preventDefault();
      } else if (e.key === "ArrowUp") {
        setExpandedIdx((prev) => Math.max((prev ?? 1) - 1, 0));
        e.preventDefault();
      } else if (e.key === "Enter" && expandedIdx !== null) {
        setExpandedIdx((prev) => (prev !== null ? null : 0));
        e.preventDefault();
      } else if (e.key === "a" && expandedIdx !== null) {
        openResolveForm(expandedIdx, "APPROVE");
        e.preventDefault();
      } else if (e.key === "r" && expandedIdx !== null) {
        openResolveForm(expandedIdx, "REJECT");
        e.preventDefault();
      } else if (e.key === "Escape") {
        setExpandedIdx(null);
        e.preventDefault();
      }
    },
    [gates, expandedIdx, resolveIdx]
  );

  useEffect(() => {
    const el = listRef.current;
    if (el) {
      el.addEventListener("keydown", handleKeyDown);
      return () => el.removeEventListener("keydown", handleKeyDown);
    }
  }, [handleKeyDown]);

  function openResolveForm(idx: number, d: "APPROVE" | "REJECT") {
    setResolveIdx(idx);
    setDecision(d);
    setReason("");
    setResolveError(null);
  }

  async function handleSubmitResolve() {
    if (resolveIdx === null) return;
    if (reason.trim().length < 10) {
      setResolveError("Reason must be at least 10 characters.");
      return;
    }
    const gate = gates[resolveIdx];
    try {
      await resolveMutation.mutateAsync({
        gateId: gate.gate_id,
        body: {
          decision,
          payload: { candidate_ids: extractCandidateIds(gate.payload) },
          reason_comment: reason.trim(),
        },
      });
      setResolveIdx(null);
      setReason("");
      setResolveError(null);
    } catch (err: any) {
      setResolveError(err?.message ?? "Failed to resolve gate.");
    }
  }

  // ─── No-token state ──────────────────────────────────────────────
  if (!hasToken) {
    return (
      <EmptyState message="Connect with a dev token to view pending gates." />
    );
  }

  // ─── Loading state ───────────────────────────────────────────────
  if (isLoading) {
    return <EmptyState message="Loading pending gates…" />;
  }

  // ─── Error state ─────────────────────────────────────────────────
  if (isError) {
    return (
      <EmptyState
        message="Could not reach the gates API. Check the token and API origin."
        tone="danger"
      />
    );
  }

  // ─── Empty state with live stats ─────────────────────────────────
  if (gates.length === 0) {
    return (
      <div className="flex h-full flex-col">
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-text-secondary">
            Pending Gates
          </h3>
          <span className="rounded-full bg-agent/10 px-2 py-0.5 text-xs font-medium text-agent">
            0 pending
          </span>
        </div>
        <div className="flex flex-1 flex-col items-center justify-center rounded-md border border-dashed border-border-soft py-10">
          <div className="mb-2 text-3xl"><Icon icon={getIcon("CircleCheck")} size={32} tone="system" className="mx-auto" /></div>
          <p className="text-sm font-medium text-success">No gates waiting for review.</p>
          <p className="mt-1 text-xs text-text-secondary">
            Pipeline is flowing — all decisions have been made.
          </p>
        </div>
      </div>
    );
  }

  // ─── Main table ──────────────────────────────────────────────────
  return (
    <div ref={listRef} className="flex h-full flex-col" tabIndex={0}>
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-text-secondary">
          Pending Gates
        </h3>
        <span className="rounded-full bg-attention/10 px-2 py-0.5 text-xs font-medium text-attention">
          {gates.length} awaiting decision
        </span>
      </div>

      <div className="flex-1 overflow-auto rounded-md border border-border-soft">
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-border-soft bg-background text-xs uppercase tracking-wide text-text-secondary">
              <th className="px-3 py-2">Gate Type</th>
              <th className="px-3 py-2">Batch</th>
              <th className="px-3 py-2 text-right">Candidates</th>
              <th className="px-3 py-2">Created</th>
              <th className="px-3 py-2">Timeout</th>
              <th className="px-3 py-2 text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {gates.map((gate, idx) => {
              const isExpanded = expandedIdx === idx;
              const isResolving = resolveIdx === idx;
              const candidateIds = extractCandidateIds(gate.payload);
              return (
                <GateRow
                  key={gate.gate_id}
                  gate={gate}
                  isExpanded={isExpanded}
                  isResolving={isResolving}
                  candidateIds={candidateIds}
                  tick={tick}
                  onToggleExpand={() =>
                    setExpandedIdx(isExpanded ? null : idx)
                  }
                  onApprove={() => openResolveForm(idx, "APPROVE")}
                  onReject={() => openResolveForm(idx, "REJECT")}
                />
              );
            })}
          </tbody>
        </table>
      </div>

      {/* ─── Resolve form (slides in below table) ──────────────────── */}
      {resolveIdx !== null && gates[resolveIdx] && (
        <div className="mt-3 rounded-lg border border-human/30 bg-surface p-4">
          <div className="mb-2 flex items-center justify-between">
            <h4 className="text-sm font-semibold text-text-primary">
              Resolve: {GATE_TYPE_LABELS[gates[resolveIdx].gate_type] ?? gates[resolveIdx].gate_type}
            </h4>
            <button
              onClick={() => {
                setResolveIdx(null);
                setReason("");
                setResolveError(null);
              }}
              className="text-xs text-text-secondary hover:text-text-primary"
            >
              Esc
            </button>
          </div>

          {/* Decision toggle */}
          <div className="mb-3 flex gap-2">
            <button
              onClick={() => setDecision("APPROVE")}
              className={`rounded-md px-3 py-1.5 text-xs font-semibold transition-colors ${
                decision === "APPROVE"
                  ? "bg-agent text-white"
                  : "border border-border-soft text-text-secondary hover:bg-background"
              }`}
            >
              Approve
            </button>
            <button
              onClick={() => setDecision("REJECT")}
              className={`rounded-md px-3 py-1.5 text-xs font-semibold transition-colors ${
                decision === "REJECT"
                  ? "bg-human text-white"
                  : "border border-border-soft text-text-secondary hover:bg-background"
              }`}
            >
              Reject
            </button>
          </div>

          {/* Reason textarea */}
          <label className="mb-1 block text-xs font-medium text-text-secondary">
            Reason (min 10 characters)
          </label>
          <textarea
            ref={reasonRef}
            value={reason}
            onChange={(e) => {
              setReason(e.target.value);
              if (resolveError) setResolveError(null);
            }}
            rows={3}
            className="w-full rounded-md border border-border-soft bg-background px-3 py-2 text-sm text-text-primary placeholder:text-text-secondary/50 focus:border-agent focus:outline-none focus:ring-1 focus:ring-agent"
            placeholder={
              decision === "APPROVE"
                ? "e.g. All candidates pass eligibility checks, proceed to scoring."
                : "e.g. Candidate documents are incomplete, cannot proceed."
            }
          />
          {resolveError && (
            <p className="mt-1 text-xs text-danger">{resolveError}</p>
          )}
          <p className="mt-1 text-right text-xs text-text-secondary">
            {reason.length}/10 min
          </p>

          {/* Submit */}
          <div className="mt-2 flex justify-end gap-2">
            <button
              onClick={() => {
                setResolveIdx(null);
                setReason("");
                setResolveError(null);
              }}
              className="rounded-md border border-border-soft px-4 py-1.5 text-xs font-medium text-text-secondary hover:bg-background"
            >
              Cancel
            </button>
            <button
              onClick={handleSubmitResolve}
              disabled={resolveMutation.isPending || reason.trim().length < 10}
              className={`rounded-md px-4 py-1.5 text-xs font-semibold text-white transition-colors disabled:opacity-50 ${
                decision === "APPROVE"
                  ? "bg-agent hover:bg-agent/90"
                  : "bg-human hover:bg-human/90"
              }`}
            >
              {resolveMutation.isPending
                ? "Resolving…"
                : decision === "APPROVE"
                  ? "Approve Gate"
                  : "Reject Gate"}
            </button>
          </div>

          {resolveMutation.isError && (
            <p className="mt-2 text-xs text-danger">
              {(resolveMutation.error as Error)?.message ?? "Failed to resolve gate."}
            </p>
          )}
        </div>
      )}

      {/* Keyboard hint */}
      <div className="mt-2 flex gap-3 text-xs text-text-secondary/60">
        <span>\u2191\u2193 navigate</span>
        <span>{t("hil.enter")}</span>
        <span>{t("hil.a")}</span>
        <span>{t("hil.r")}</span>
        <span>{t("hil.esc")}</span>
      </div>
    </div>
  );
}

// ─── Gate row sub-component ──────────────────────────────────────────

function GateRow({
  gate,
  isExpanded,
  isResolving,
  candidateIds,
  tick,
  onToggleExpand,
  onApprove,
  onReject,
}: {
  gate: GateSummary;
  isExpanded: boolean;
  isResolving: boolean;
  candidateIds: string[];
  tick: number;
  onToggleExpand: () => void;
  onApprove: () => void;
  onReject: () => void;
}) {
  // Suppress unused-variable warning — tick triggers re-render for countdown
  void tick;

  return (
    <>
      <tr
        onClick={onToggleExpand}
        className={`cursor-pointer border-b border-border-soft last:border-0 transition-colors ${
          isResolving
            ? "bg-attention/5"
            : isExpanded
              ? "bg-background"
              : "hover:bg-background/50"
        }`}
      >
        <td className="px-3 py-2.5">
          <div className="flex items-center gap-2">
            <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-attention" />
            <span className="text-sm font-medium text-text-primary">
              {GATE_TYPE_LABELS[gate.gate_type] ?? gate.gate_type}
            </span>
          </div>
        </td>
        <td className="px-3 py-2.5">
          <span className="font-mono text-xs text-text-secondary">
            {gate.batch_id.length > 24
              ? gate.batch_id.slice(0, 24) + "…"
              : gate.batch_id}
          </span>
        </td>
        <td className="px-3 py-2.5 text-right">
          <span className="rounded bg-agent/10 px-1.5 py-0.5 text-xs font-medium text-agent">
            {candidateIds.length > 0 ? candidateIds.length : "—"}
          </span>
        </td>
        <td className="px-3 py-2.5 text-xs text-text-secondary">
          {new Date(gate.created_at).toLocaleString()}
        </td>
        <td className="px-3 py-2.5 text-xs text-attention">
          {formatCountdown(gate.created_at)}
        </td>
        <td className="px-3 py-2.5 text-right">
          <div className="flex justify-end gap-1.5" onClick={(e) => e.stopPropagation()}>
            <button
              onClick={onApprove}
              className="rounded bg-agent/10 px-2 py-1 text-xs font-medium text-agent hover:bg-agent/20 transition-colors"
              title="Approve (A)"
            >
              Approve
            </button>
            <button
              onClick={onReject}
              className="rounded bg-human/10 px-2 py-1 text-xs font-medium text-human hover:bg-human/20 transition-colors"
              title="Reject (R)"
            >
              Reject
            </button>
          </div>
        </td>
      </tr>
      {isExpanded && candidateIds.length > 0 && (
        <tr className="border-b border-border-soft bg-background">
          <td colSpan={6} className="px-3 py-2">
            <div className="ml-4">
              <p className="mb-1 text-xs font-medium text-text-secondary">
                Candidate IDs in this gate:
              </p>
              <div className="flex flex-wrap gap-1.5">
                {candidateIds.map((id) => (
                  <span
                    key={id}
                    className="rounded border border-border-soft bg-surface px-2 py-0.5 font-mono text-xs text-text-primary"
                  >
                    {id}
                  </span>
                ))}
              </div>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

// ─── Empty state ─────────────────────────────────────────────────────

function EmptyState({
  message,
  tone = "neutral",
}: {
  message: string;
  tone?: "neutral" | "danger" | "success";
}) {
  const color =
    tone === "danger" ? "text-danger" : tone === "success" ? "text-success" : "text-text-secondary";
  return (
    <div className="flex flex-1 items-center justify-center rounded-md border border-dashed border-border-soft py-8">
      <p className={`text-sm ${color}`}>{message}</p>
    </div>
  );
}
