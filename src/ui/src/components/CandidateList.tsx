/**
 * CandidateList — Quest 05 Part 4.
 *
 * Filterable, sortable, paginated candidate table. Consumes the
 * `#/candidates?status=X` hash opened by PipelineStrip (Part 3).
 * Clicking a row opens the CandidateInspector side panel.
 */
import { useState, useEffect, useMemo, useCallback } from "react";
import { useQuery } from "@tanstack/react-query";
import { fetchCandidateList, getToken, type CandidateListParams } from "../api/client";

const STATUSES = [
  "", "INTAKE", "PARSED", "ELIGIBILITY_DONE", "NEEDS_REVIEW", "SCORED",
  "SHORTLISTED", "VERIFIED", "REJECTED", "SELECTED", "WITHDRAWN",
];
const SOURCES = ["", "Teletalk", "bdjobs", "LinkedIn", "Email", "WhatsApp", "CSV"];
const PAGE_SIZE = 25;

interface Props {
  onInspect?: (candidateId: string) => void;
}

export function CandidateList({ onInspect }: Props) {
  const hasToken = !!getToken();

  // Parse hash params: #/candidates?status=NEEDS_REVIEW&circular_id=...
  const hashParams = useMemo(() => {
    const hash = window.location.hash.replace(/^#\/candidates\??/, "");
    return new URLSearchParams(hash);
  }, []);

  const [statusFilter, setStatusFilter] = useState(hashParams.get("status") ?? "");
  const [sourceFilter, setSourceFilter] = useState("");
  const [searchText, setSearchText] = useState("");
  const [page, setPage] = useState(0);
  const [sortField, setSortField] = useState<"created_at" | "full_name" | "status">("created_at");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [selected, setSelected] = useState<Set<string>>(new Set());

  // Build query params
  const params: CandidateListParams = useMemo(() => ({
    status: statusFilter || undefined,
    search: searchText || undefined,
    limit: PAGE_SIZE,
    offset: page * PAGE_SIZE,
  }), [statusFilter, searchText, page]);

  const { data, isLoading, isError } = useQuery({
    queryKey: ["candidate-list", params],
    queryFn: () => fetchCandidateList(params),
    enabled: hasToken,
    staleTime: 5_000,
    retry: 1,
  });

  const candidates = data?.candidates ?? [];
  const totalCount = data?.count ?? 0;
  const totalPages = Math.ceil(totalCount / PAGE_SIZE);

  // Client-side sort (server sorts by created_at; we refine locally)
  const sorted = useMemo(() => {
    const arr = [...candidates];
    arr.sort((a, b) => {
      const av = a[sortField] ?? "";
      const bv = b[sortField] ?? "";
      const cmp = typeof av === "string" ? av.localeCompare(bv as string) : 0;
      return sortDir === "asc" ? cmp : -cmp;
    });
    return arr;
  }, [candidates, sortField, sortDir]);

  // Filter by source client-side (server doesn't filter by source)
  const filtered = useMemo(() => {
    if (!sourceFilter) return sorted;
    return sorted.filter((c) => c.source_platform === sourceFilter);
  }, [sorted, sourceFilter]);

  const toggleSort = useCallback((field: typeof sortField) => {
    if (sortField === field) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortField(field);
      setSortDir("asc");
    }
  }, [sortField]);

  const toggleSelect = useCallback((id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);

  const toggleAll = useCallback(() => {
    setSelected((prev) => {
      if (prev.size === filtered.length) return new Set();
      return new Set(filtered.map((c) => c.candidate_id));
    });
  }, [filtered]);

  // Reset page when filters change
  useEffect(() => { setPage(0); }, [statusFilter, sourceFilter, searchText]);

  function handleExport() {
    const rows = filtered.filter((c) => selected.has(c.candidate_id));
    if (rows.length === 0) return;
    const csv = [
      "candidate_id,full_name,status,source_platform,job_circular_id,data_confidence,created_at",
      ...rows.map((c) =>
        `${c.candidate_id},"${c.full_name}",${c.status},${c.source_platform ?? ""},${c.job_circular_id ?? ""},${c.data_confidence ?? ""},${c.created_at}`
      ),
    ].join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `candidates-export-${Date.now()}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="flex h-full flex-col rounded-lg border border-border-soft bg-surface">
      {/* Filters bar */}
      <div className="flex flex-wrap items-center gap-3 border-b border-border-soft p-3">
        <h2 className="text-sm font-semibold text-text-primary">Candidates</h2>

        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          className="rounded border border-border-soft bg-background px-2 py-1 text-xs text-text-primary"
        >
          <option value="">All statuses</option>
          {STATUSES.filter(Boolean).map((s) => (
            <option key={s} value={s}>{s.replace(/_/g, " ")}</option>
          ))}
        </select>

        <select
          value={sourceFilter}
          onChange={(e) => setSourceFilter(e.target.value)}
          className="rounded border border-border-soft bg-background px-2 py-1 text-xs text-text-primary"
        >
          <option value="">All sources</option>
          {SOURCES.filter(Boolean).map((s) => (
            <option key={s} value={s}>{s}</option>
          ))}
        </select>

        <input
          type="text"
          placeholder="Search name or ID…"
          value={searchText}
          onChange={(e) => setSearchText(e.target.value)}
          className="w-48 rounded border border-border-soft bg-background px-2 py-1 text-xs text-text-primary placeholder:text-text-secondary"
        />

        {selected.size > 0 && (
          <button
            onClick={handleExport}
            className="ml-auto rounded bg-agent px-3 py-1 text-xs text-white hover:bg-agent/80"
          >
            Export {selected.size} selected
          </button>
        )}
      </div>

      {/* Content */}
      {!hasToken ? (
        <EmptyState message="Sign in to view candidates." />
      ) : isLoading ? (
        <EmptyState message="Loading candidates…" />
      ) : isError ? (
        <EmptyState message="Could not load candidates. Check your connection." tone="danger" />
      ) : filtered.length === 0 ? (
        <EmptyState message="No candidates match the current filters." />
      ) : (
        <>
          <div className="flex-1 overflow-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-border-soft text-xs uppercase tracking-wide text-text-secondary">
                  <th className="py-2 pr-2">
                    <input
                      type="checkbox"
                      checked={selected.size === filtered.length && filtered.length > 0}
                      onChange={toggleAll}
                      className="rounded border-border-soft"
                    />
                  </th>
                  <SortHeader label="Candidate" field="full_name" current={sortField} dir={sortDir} onToggle={toggleSort} />
                  <SortHeader label="Status" field="status" current={sortField} dir={sortDir} onToggle={toggleSort} />
                  <th className="py-2 pr-3">Source</th>
                  <th className="py-2 pr-3">Circular</th>
                  <th className="py-2 pr-3">Confidence</th>
                  <SortHeader label="Created" field="created_at" current={sortField} dir={sortDir} onToggle={toggleSort} />
                </tr>
              </thead>
              <tbody>
                {filtered.map((c) => (
                  <tr
                    key={c.candidate_id}
                    className={`cursor-pointer border-b border-border-soft last:border-0 transition-colors ${
                      selected.has(c.candidate_id) ? "bg-agent/5" : "hover:bg-background"
                    }`}
                    onClick={() => onInspect?.(c.candidate_id)}
                  >
                    <td className="py-2 pr-2" onClick={(e) => e.stopPropagation()}>
                      <input
                        type="checkbox"
                        checked={selected.has(c.candidate_id)}
                        onChange={() => toggleSelect(c.candidate_id)}
                        className="rounded border-border-soft"
                      />
                    </td>
                    <td className="py-2 pr-3">
                      <div className="font-medium text-text-primary">{c.full_name || "—"}</div>
                      <div className="text-xs text-text-secondary">{c.candidate_id}</div>
                    </td>
                    <td className="py-2 pr-3">
                      <StatusBadge status={c.status} />
                    </td>
                    <td className="py-2 pr-3 text-xs text-text-secondary">{c.source_platform ?? "—"}</td>
                    <td className="py-2 pr-3 text-xs text-text-secondary">{c.job_circular_id ?? "—"}</td>
                    <td className="py-2 pr-3">
                      <ConfidenceBadge confidence={c.data_confidence} />
                    </td>
                    <td className="py-2 text-xs text-text-secondary">{new Date(c.created_at).toLocaleDateString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Pagination */}
          <div className="flex items-center justify-between border-t border-border-soft px-3 py-2 text-xs text-text-secondary">
            <span>{totalCount} candidate{totalCount !== 1 ? "s" : ""} total</span>
            <div className="flex items-center gap-2">
              <button
                disabled={page === 0}
                onClick={() => setPage((p) => p - 1)}
                className="rounded border border-border-soft px-2 py-1 disabled:opacity-40"
              >
                ← Prev
              </button>
              <span>Page {page + 1} of {Math.max(1, totalPages)}</span>
              <button
                disabled={page >= totalPages - 1}
                onClick={() => setPage((p) => p + 1)}
                className="rounded border border-border-soft px-2 py-1 disabled:opacity-40"
              >
                Next →
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

// ─── Helpers ─────────────────────────────────────────────────────────

function SortHeader({ label, field, current, dir, onToggle }: {
  label: string; field: "created_at" | "full_name" | "status"; current: string; dir: string; onToggle: (f: typeof field) => void;
}) {
  const active = current === field;
  return (
    <th className="cursor-pointer py-2 pr-3" onClick={() => onToggle(field)}>
      <span className="flex items-center gap-1">
        {label}
        {active && <span className="text-agent">{dir === "asc" ? "↑" : "↓"}</span>}
      </span>
    </th>
  );
}

function StatusBadge({ status }: { status: string }) {
  const colors: Record<string, string> = {
    INTAKE: "bg-background text-text-secondary",
    PARSED: "bg-agent/10 text-agent",
    ELIGIBILITY_DONE: "bg-agent/10 text-agent",
    NEEDS_REVIEW: "bg-attention/10 text-attention",
    SCORED: "bg-agent/10 text-agent",
    SHORTLISTED: "bg-success/10 text-success",
    VERIFIED: "bg-success/10 text-success",
    SELECTED: "bg-success/10 text-success",
    REJECTED: "bg-danger/10 text-danger",
    WITHDRAWN: "bg-background text-text-secondary",
  };
  return (
    <span className={`inline-block rounded px-2 py-0.5 text-xs font-medium ${colors[status] ?? "bg-background text-text-secondary"}`}>
      {status.replace(/_/g, " ")}
    </span>
  );
}

function ConfidenceBadge({ confidence }: { confidence: string | null }) {
  const color = confidence === "Low" ? "text-attention" : confidence === "Medium" ? "text-text-secondary" : "text-agent";
  return <span className={`text-xs font-medium ${color}`}>{confidence ?? "—"}</span>;
}

function EmptyState({ message, tone = "neutral" }: { message: string; tone?: "neutral" | "danger" }) {
  const color = tone === "danger" ? "text-danger" : "text-text-secondary";
  return (
    <div className="flex flex-1 items-center justify-center py-12">
      <p className={`text-sm ${color}`}>{message}</p>
    </div>
  );
}
