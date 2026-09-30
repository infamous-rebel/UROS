import { useState, useEffect, useCallback, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { usePendingGates, useResolveGate } from "../hooks/hooks_gates";
import { getToken, fetchAuditLogs, type GateSummary, type AuditLogEntry } from "../api/client";
import { getIcon } from "./navigation/iconRegistry";
import { Icon } from "./navigation/Icon";
import { useI18n } from "../i18n";

const MIN_REASON_LENGTH = 10;

const GATE_TIMEOUT_MS = 1000 * 60 * 60 * 24 * 30; // 30 days — matches env.schema.ts

const GATE_TYPE_LABEL_KEYS: Record<string, string> = {
  IMPORT_APPROVAL: "hil.gate.IMPORT_APPROVAL",
  ELIGIBILITY_REVIEW: "hil.gate.ELIGIBILITY_REVIEW",
  SHORTLIST_CONFIRMATION: "hil.gate.SHORTLIST_CONFIRMATION",
  VERIFICATION_SIGNOFF: "hil.gate.VERIFICATION_SIGNOFF",
  COMMUNICATION_APPROVAL: "hil.gate.COMMUNICATION_APPROVAL",
  FINAL_APPROVAL: "hil.gate.FINAL_APPROVAL",
};

type TFn = (key: string, vars?: Record<string, string | number>) => string;

function gateTypeLabel(type: string, t: TFn): string {
  const key = GATE_TYPE_LABEL_KEYS[type];
  return key ? t(key) : type;
}

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
  const [reasonTouched, setReasonTouched] = useState(false);
  const [resolveError, setResolveError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const reasonRef = useRef<HTMLTextAreaElement>(null);

  // ─── Part 11: Batch gate operations ─────────────────────────
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [batchOpen, setBatchOpen] = useState(false);
  const [batchDecision, setBatchDecision] = useState<"APPROVE" | "REJECT">("APPROVE");
  const [batchReason, setBatchReason] = useState("");
  const [batchReasonTouched, setBatchReasonTouched] = useState(false);
  const [batchProgress, setBatchProgress] = useState<{ done: number; total: number } | null>(null);
  const [batchResult, setBatchResult] = useState<{ ok: number; failed: number } | null>(null);
  const batchReasonRef = useRef<HTMLTextAreaElement>(null);

  // ─── Part 11: Gate audit trail (recently resolved) ──────────
  const audit = useQuery({
    queryKey: ["audit-logs-gates"],
    queryFn: () => fetchAuditLogs(50),
    refetchInterval: 15_000,
    enabled: hasToken,
    retry: false,
  });
  const gateTrail = (audit.data?.entries ?? [])
    .filter((e: AuditLogEntry) => e.action === "GATE_RESOLVED" || e.action === "GATE_CREATED")
    .slice(0, 5);

  const reasonInvalid = reason.trim().length < MIN_REASON_LENGTH;
  const batchReasonInvalid = batchReason.trim().length < MIN_REASON_LENGTH;

  const toggleSelect = useCallback((gateId: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(gateId)) next.delete(gateId); else next.add(gateId);
      return next;
    });
  }, []);

  const toggleAll = useCallback(() => {
    setSelected((prev) => {
      if (prev.size === gates.length) return new Set();
      return new Set(gates.map((g) => g.gate_id));
    });
  }, [gates]);

  function openBatchForm(d: "APPROVE" | "REJECT") {
    setBatchOpen(true);
    setBatchDecision(d);
    setBatchReason("");
    setBatchReasonTouched(false);
    setBatchResult(null);
    setBatchProgress(null);
    setTimeout(() => batchReasonRef.current?.focus(), 50);
  }

  async function handleBatchResolve() {
    const targets = gates.filter((g) => selected.has(g.gate_id));
    if (targets.length === 0 || batchReasonInvalid) return;
    setBatchProgress({ done: 0, total: targets.length });
    let ok = 0;
    let failed = 0;
    for (let i = 0; i < targets.length; i++) {
      try {
        await resolveMutation.mutateAsync({
          gateId: targets[i].gate_id,
          body: {
            decision: batchDecision,
            payload: { candidate_ids: extractCandidateIds(targets[i].payload) },
            reason_comment: batchReason.trim(),
          },
        });
        ok++;
      } catch {
        failed++;
      }
      setBatchProgress({ done: i + 1, total: targets.length });
    }
    setBatchResult({ ok, failed });
    setBatchProgress(null);
    setSelected(new Set());
  }

  function closeBatchForm() {
    setBatchOpen(false);
    setBatchReason("");
    setBatchReasonTouched(false);
    setBatchProgress(null);
    setBatchResult(null);
  }

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
    setReasonTouched(false);
    setResolveError(null);
  }

  async function handleSubmitResolve() {
    if (resolveIdx === null) return;
    setReasonTouched(true);
    if (reasonInvalid) {
      setResolveError(t("hil.reasonMinError"));
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
      setReasonTouched(false);
      setResolveError(null);
    } catch (err: any) {
      setResolveError(err?.message ?? "Failed to resolve gate.");
    }
  }

  // ─── No-token state ──────────────────────────────────────────────
  if (!hasToken) {
    return (
      <EmptyState message={t("hil.connectPrompt")} />
    );
  }

  // ─── Loading state ───────────────────────────────────────────────
  if (isLoading) {
    return <EmptyState message={t("hil.loading")} />;
  }

  // ─── Error state ─────────────────────────────────────────────────
  if (isError) {
    return (
      <EmptyState
        message={t("hil.apiError")}
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
            {t("hil.pendingGates")}
          </h3>
          <span className="rounded-full bg-agent/10 px-2 py-0.5 text-xs font-medium text-agent">
            {t("hil.zeroPending")}
          </span>
        </div>
        <div className="flex flex-1 flex-col items-center justify-center rounded-md border border-dashed border-border-soft py-10">
          <div className="mb-2 text-3xl"><Icon icon={getIcon("CircleCheck")} size={32} tone="system" className="mx-auto" /></div>
          <p className="text-sm font-medium text-success">{t("hil.emptyTitle")}</p>
          <p className="mt-1 text-xs text-text-secondary">
            {t("hil.emptyBody")}
          </p>
        </div>
        <GateAuditTrail entries={gateTrail} isLoading={audit.isLoading} isError={audit.isError} />
      </div>
    );
  }

  // ─── Main table ──────────────────────────────────────────────────
  return (
    <div ref={listRef} className="flex h-full flex-col" tabIndex={0}>
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-text-secondary">
          {t("hil.pendingGates")}
        </h3>
        <span className="rounded-full bg-attention/10 px-2 py-0.5 text-xs font-medium text-attention">
          {t("hil.awaitingDecision", { count: gates.length })}
        </span>
      </div>

      {/* ─── Part 11: Batch action bar ─────────────────────────────── */}
      {selected.size > 0 && !batchOpen && (
        <div className="mb-3 flex items-center gap-3 rounded-md bg-human/5 px-3 py-2 text-sm">
          <span className="font-medium text-human">{t("hil.batch.selected", { count: selected.size })}</span>
          <div className="flex gap-2">
            <button
              onClick={() => openBatchForm("APPROVE")}
              className="rounded bg-agent px-2 py-1 text-xs text-white hover:bg-agent/80"
            >
              {t("hil.batch.approveSelected", { count: selected.size })}
            </button>
            <button
              onClick={() => openBatchForm("REJECT")}
              className="rounded bg-human px-2 py-1 text-xs text-white hover:bg-human/80"
            >
              {t("hil.batch.rejectSelected", { count: selected.size })}
            </button>
          </div>
          <button
            onClick={() => setSelected(new Set())}
            className="ml-auto text-xs text-text-secondary hover:text-text-primary"
          >
            {t("hil.batch.clear")}
          </button>
        </div>
      )}

      <div className="flex-1 overflow-auto rounded-md border border-border-soft">
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-border-soft bg-background text-xs uppercase tracking-wide text-text-secondary">
              <th className="px-3 py-2">
                <input
                  type="checkbox"
                  checked={selected.size === gates.length && gates.length > 0}
                  onChange={toggleAll}
                  className="rounded border-border-soft"
                />
              </th>
              <th className="px-3 py-2">{t("hil.col.gateType")}</th>
              <th className="px-3 py-2">{t("hil.col.batch")}</th>
              <th className="px-3 py-2 text-right">{t("hil.col.candidates")}</th>
              <th className="px-3 py-2">{t("hil.col.created")}</th>
              <th className="px-3 py-2">{t("hil.col.timeout")}</th>
              <th className="px-3 py-2 text-right">{t("hil.col.actions")}</th>
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
                  isSelected={selected.has(gate.gate_id)}
                  onToggleSelect={() => toggleSelect(gate.gate_id)}
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
              {t("hil.resolveTitle", { type: gateTypeLabel(gates[resolveIdx].gate_type, t) })}
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
              {t("queue.approve")}
            </button>
            <button
              onClick={() => setDecision("REJECT")}
              className={`rounded-md px-3 py-1.5 text-xs font-semibold transition-colors ${
                decision === "REJECT"
                  ? "bg-human text-white"
                  : "border border-border-soft text-text-secondary hover:bg-background"
              }`}
            >
              {t("queue.reject")}
            </button>
          </div>

          {/* Reason textarea */}
          <label className="mb-1 block text-xs font-medium text-text-secondary">
            {t("hil.reasonLabel")}
          </label>
          <textarea
            ref={reasonRef}
            value={reason}
            onChange={(e) => {
              setReason(e.target.value);
              setReasonTouched(true);
              if (resolveError) setResolveError(null);
            }}
            rows={3}
            className={`w-full rounded-md border bg-background px-3 py-2 text-sm text-text-primary placeholder:text-text-secondary/50 focus:outline-none focus:ring-1 ${
              reasonTouched && reasonInvalid
                ? "border-danger focus:border-danger focus:ring-danger"
                : "border-border-soft focus:border-agent focus:ring-agent"
            }`}
            placeholder={
              decision === "APPROVE"
                ? t("hil.reasonPlaceholderApprove")
                : t("hil.reasonPlaceholderReject")
            }
          />
          {resolveError && (
            <p className="mt-1 text-xs text-danger">{resolveError}</p>
          )}
          {!resolveError && reasonTouched && reasonInvalid && (
            <p className="mt-1 text-xs text-danger">{t("hil.reasonMinError")}</p>
          )}
          <p className="mt-1 text-right text-xs text-text-secondary">
            {t("hil.reasonCounter", { count: reason.length })}
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
              {t("common.cancel")}
            </button>
            <button
              onClick={handleSubmitResolve}
              disabled={resolveMutation.isPending || reasonInvalid}
              className={`rounded-md px-4 py-1.5 text-xs font-semibold text-white transition-colors disabled:opacity-50 ${
                decision === "APPROVE"
                  ? "bg-agent hover:bg-agent/90"
                  : "bg-human hover:bg-human/90"
              }`}
            >
              {resolveMutation.isPending
                ? t("hil.resolving")
                : decision === "APPROVE"
                  ? t("hil.approveGate")
                  : t("hil.rejectGate")}
            </button>
          </div>

          {resolveMutation.isError && (
            <p className="mt-2 text-xs text-danger">
              {(resolveMutation.error as Error)?.message ?? "Failed to resolve gate."}
            </p>
          )}
        </div>
      )}

      {/* ─── Part 11: Batch resolve form ───────────────────────────── */}
      {batchOpen && (
        <div className="mt-3 rounded-lg border border-human/30 bg-surface p-4">
          <div className="mb-2 flex items-center justify-between">
            <h4 className="text-sm font-semibold text-text-primary">
              {t("hil.batch.title")} — {t("hil.batch.selected", { count: selected.size })}
            </h4>
            <button
              onClick={closeBatchForm}
              className="text-xs text-text-secondary hover:text-text-primary"
            >
              Esc
            </button>
          </div>

          {/* Decision toggle */}
          <div className="mb-3 flex gap-2">
            <button
              onClick={() => setBatchDecision("APPROVE")}
              className={`rounded-md px-3 py-1.5 text-xs font-semibold transition-colors ${
                batchDecision === "APPROVE"
                  ? "bg-agent text-white"
                  : "border border-border-soft text-text-secondary hover:bg-background"
              }`}
            >
              {t("queue.approve")}
            </button>
            <button
              onClick={() => setBatchDecision("REJECT")}
              className={`rounded-md px-3 py-1.5 text-xs font-semibold transition-colors ${
                batchDecision === "REJECT"
                  ? "bg-human text-white"
                  : "border border-border-soft text-text-secondary hover:bg-background"
              }`}
            >
              {t("queue.reject")}
            </button>
          </div>

          {/* Shared reason */}
          <label className="mb-1 block text-xs font-medium text-text-secondary">
            {t("hil.batch.sharedReason")}
          </label>
          <textarea
            ref={batchReasonRef}
            value={batchReason}
            onChange={(e) => {
              setBatchReason(e.target.value);
              setBatchReasonTouched(true);
            }}
            rows={3}
            className={`w-full rounded-md border bg-background px-3 py-2 text-sm text-text-primary placeholder:text-text-secondary/50 focus:outline-none focus:ring-1 ${
              batchReasonTouched && batchReasonInvalid
                ? "border-danger focus:border-danger focus:ring-danger"
                : "border-border-soft focus:border-agent focus:ring-agent"
            }`}
            placeholder={
              batchDecision === "APPROVE"
                ? "e.g. Batch verified against source records — all valid."
                : "e.g. Batch failed source verification — returning to intake."
            }
          />
          {batchReasonTouched && batchReasonInvalid && (
            <p className="mt-1 text-xs text-danger">{t("hil.reasonMinError")}</p>
          )}
          <p className="mt-1 text-right text-xs text-text-secondary">
            {t("hil.reasonCounter", { count: batchReason.length })}
          </p>

          {/* Progress / result */}
          {batchProgress && (
            <p className="mt-2 text-xs font-medium text-attention">
              {t("hil.batch.progress", { done: batchProgress.done, total: batchProgress.total })}
            </p>
          )}
          {batchResult && (
            <p className={`mt-2 text-xs font-medium ${batchResult.failed === 0 ? "text-success" : "text-attention"}`}>
              {t("hil.batch.done", { ok: batchResult.ok, failed: batchResult.failed })}
            </p>
          )}

          {/* Submit */}
          <div className="mt-2 flex justify-end gap-2">
            <button
              onClick={closeBatchForm}
              className="rounded-md border border-border-soft px-4 py-1.5 text-xs font-medium text-text-secondary hover:bg-background"
            >
              {t("common.cancel")}
            </button>
            <button
              onClick={handleBatchResolve}
              disabled={resolveMutation.isPending || batchReasonInvalid || batchProgress !== null}
              className={`rounded-md px-4 py-1.5 text-xs font-semibold text-white transition-colors disabled:opacity-50 ${
                batchDecision === "APPROVE"
                  ? "bg-agent hover:bg-agent/90"
                  : "bg-human hover:bg-human/90"
              }`}
            >
              {batchProgress
                ? t("hil.batch.progress", { done: batchProgress.done, total: batchProgress.total })
                : t("hil.batch.submit", { count: selected.size })}
            </button>
          </div>
        </div>
      )}

      {/* Keyboard hint */}
      <div className="mt-2 flex gap-3 text-xs text-text-secondary/60">
        <span>↑↓ {t("hil.navigate")}</span>
        <span>{t("hil.enter")}</span>
        <span>{t("hil.a")}</span>
        <span>{t("hil.r")}</span>
        <span>{t("hil.esc")}</span>
      </div>

      {/* ─── Part 11: Gate audit trail — recently resolved ────────── */}
      <GateAuditTrail entries={gateTrail} isLoading={audit.isLoading} isError={audit.isError} />
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
  isSelected,
  onToggleSelect,
  onToggleExpand,
  onApprove,
  onReject,
}: {
  gate: GateSummary;
  isExpanded: boolean;
  isResolving: boolean;
  candidateIds: string[];
  tick: number;
  isSelected: boolean;
  onToggleSelect: () => void;
  onToggleExpand: () => void;
  onApprove: () => void;
  onReject: () => void;
}) {
  const { t } = useI18n();
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
        <td className="px-3 py-2.5" onClick={(e) => e.stopPropagation()}>
          <input
            type="checkbox"
            checked={isSelected}
            onChange={onToggleSelect}
            className="rounded border-border-soft"
          />
        </td>
        <td className="px-3 py-2.5">
          <div className="flex items-center gap-2">
            <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-attention" />
            <span className="text-sm font-medium text-text-primary">
              {gateTypeLabel(gate.gate_type, t)}
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
              title={t("hil.approveShortcut")}
            >
              {t("queue.approve")}
            </button>
            <button
              onClick={onReject}
              className="rounded bg-human/10 px-2 py-1 text-xs font-medium text-human hover:bg-human/20 transition-colors"
              title={t("hil.rejectShortcut")}
            >
              {t("queue.reject")}
            </button>
          </div>
        </td>
      </tr>
      {isExpanded && candidateIds.length > 0 && (
        <tr className="border-b border-border-soft bg-background">
          <td colSpan={7} className="px-3 py-2">
            <div className="ml-4">
              <p className="mb-1 text-xs font-medium text-text-secondary">
                {t("hil.candidateIds")}
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

// ─── Part 11: Gate audit trail — recently resolved ──────────────────

function GateAuditTrail({
  entries,
  isLoading,
  isError,
}: {
  entries: AuditLogEntry[];
  isLoading: boolean;
  isError: boolean;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);

  return (
    <div className="mt-3">
      <button
        onClick={() => setOpen((p) => !p)}
        className="flex w-full items-center justify-between rounded-md border border-border-soft bg-surface px-3 py-2 text-xs font-semibold text-text-secondary hover:bg-background"
      >
        <span>{t("hil.recentTitle")}</span>
        <span aria-hidden>{open ? "▾" : "▸"}</span>
      </button>
      {open && (
        <div className="mt-1 rounded-md border border-border-soft bg-surface px-3 py-2">
          {isLoading ? (
            <p className="text-xs text-text-secondary">{t("hil.loading")}</p>
          ) : isError ? (
            <p className="text-xs text-text-secondary">{t("hil.auditUnavailable")}</p>
          ) : entries.length === 0 ? (
            <p className="text-xs text-text-secondary">{t("hil.recentEmpty")}</p>
          ) : (
            <ul className="divide-y divide-border-soft">
              {entries.map((e) => (
                <li key={e.audit_id} className="py-1.5 text-xs">
                  <div className="flex items-center justify-between gap-2">
                    <span
                      className={`rounded px-1.5 py-0.5 text-xs font-medium ${
                        e.action === "GATE_RESOLVED"
                          ? "bg-success/10 text-success"
                          : "bg-agent/10 text-agent"
                      }`}
                    >
                      {e.action === "GATE_RESOLVED"
                        ? t("hil.trail.resolved")
                        : t("hil.trail.created")}
                    </span>
                    <span className="text-text-secondary">
                      {new Date(e.timestamp).toLocaleString()}
                    </span>
                  </div>
                  <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-text-secondary">
                    <span className="font-mono">{e.entity_id}</span>
                    <span aria-hidden>·</span>
                    <span>{e.agent_or_user}</span>
                  </div>
                  {e.reason_comment && (
                    <p className="mt-0.5 italic text-text-secondary">“{e.reason_comment}”</p>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
