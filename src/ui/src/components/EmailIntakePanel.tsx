/**
 * EmailIntakePanel — Quest 05 Part 5.
 *
 * Connect IMAP, list unread emails, preview, import selected as candidate.
 * Shows meaningful empty state when IMAP is not configured.
 */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { getToken } from "../api/client";

const API_V1 = "/api/v1";

export function EmailIntakePanel() {
  const hasToken = !!getToken();

  const { data, isLoading, refetch } = useQuery({
    queryKey: ["email-unread"],
    queryFn: async () => {
      const res = await fetch(`${API_V1}/intake/email/unread`, {
        headers: { Authorization: `Bearer ${getToken()}` },
      });
      return res.json();
    },
    enabled: hasToken,
    staleTime: 30_000,
  });

  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState<string | null>(null);

  const handleImport = async (messageId: string) => {
    setImporting(true);
    setImportResult(null);
    try {
      const res = await fetch(`${API_V1}/intake/email/import`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${getToken()}` },
        body: JSON.stringify({ message_id: messageId, circular_id: "DEFAULT" }),
      });
      const data = await res.json();
      if (res.ok) {
        setImportResult(`Email imported as candidate ${data.candidate_id}.`);
      } else {
        setImportResult(`Import failed: ${data.error}`);
      }
    } catch {
      setImportResult("Network error during import.");
    } finally {
      setImporting(false);
    }
  };

  const emails = data?.emails ?? [];
  const connected = data?.connected ?? false;

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className={`inline-block h-2 w-2 rounded-full ${connected ? "bg-success" : "bg-attention"}`} />
          <span className="text-xs text-text-secondary">
            {connected ? "IMAP connected" : "IMAP not connected"}
          </span>
        </div>
        <button
          onClick={() => refetch()}
          className="rounded border border-border-soft px-2 py-1 text-xs text-text-secondary hover:text-text-primary"
        >
          Refresh
        </button>
      </div>

      {!hasToken ? (
        <p className="text-sm text-text-secondary">Sign in to access email intake.</p>
      ) : isLoading ? (
        <p className="text-sm text-text-secondary">Checking email connection…</p>
      ) : !connected ? (
        <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed border-border-soft py-8">
          <span className="text-2xl">📧</span>
          <p className="max-w-sm text-center text-sm text-text-secondary">
            {data?.message ?? "IMAP not configured. Add IMAP credentials in Settings → Integrations to connect your email inbox."}
          </p>
          <p className="text-xs text-agent">Go to Settings → Integrations → Email to configure.</p>
        </div>
      ) : emails.length === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-border-soft py-8">
          <span className="text-2xl">📭</span>
          <p className="text-sm text-text-secondary">No unread emails found.</p>
        </div>
      ) : (
        <div className="space-y-2">
          {emails.map((email: Record<string, unknown>, i: number) => (
            <div key={i} className="rounded border border-border-soft p-3">
              <div className="flex items-center justify-between">
                <div>
                  <div className="text-xs font-medium text-text-primary">{String(email.subject ?? "No subject")}</div>
                  <div className="text-xs text-text-secondary">From: {String(email.from ?? "Unknown")}</div>
                </div>
                <button
                  disabled={importing}
                  onClick={() => handleImport(String(email.message_id ?? i))}
                  className="rounded bg-agent px-3 py-1 text-xs text-white disabled:opacity-40"
                >
                  Import
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {importResult && <p className="text-xs text-text-secondary">{importResult}</p>}
    </div>
  );
}
