/**
 * Quest 05 Part 8b — Verification Center.
 * Centralized view for all verification activities across the platform.
 */

import { useState, useEffect } from "react";
import { authedRequest } from "../api/client";
import { useI18n } from "../i18n";

interface VerificationEntry {
  candidate_id: string;
  full_name: string;
  status: string;
  verified_at: string | null;
  verification_type: string;
}

export function VerificationCenter() {
  const { t } = useI18n();
  const [entries, setEntries] = useState<VerificationEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<"all" | "pending" | "verified" | "failed">("all");

  useEffect(() => {
    fetchVerifications();
  }, []);

  async function fetchVerifications() {
    try {
      // Fetch candidates with verification status
      const res = await authedRequest<{ candidates: Array<{ candidate_id: string; full_name: string; status: string }> }>(
        "/candidates?limit=100"
      );
      
      // Map to verification entries (simplified - in production would join with verification_results)
      const mapped: VerificationEntry[] = (res.candidates || []).map((c) => ({
        candidate_id: c.candidate_id,
        full_name: c.full_name,
        status: c.status === "VERIFIED" ? "verified" : c.status === "REJECTED" ? "failed" : "pending",
        verified_at: null,
        verification_type: "document",
      }));
      
      setEntries(mapped);
    } catch (err) {
      console.error("Failed to fetch verifications:", err);
    } finally {
      setLoading(false);
    }
  }

  const filtered = filter === "all" ? entries : entries.filter((e) => e.status === filter);

  const counts = {
    all: entries.length,
    pending: entries.filter((e) => e.status === "pending").length,
    verified: entries.filter((e) => e.status === "verified").length,
    failed: entries.filter((e) => e.status === "failed").length,
  };

  if (loading) {
    return <div className="py-8 text-center text-sm text-text-secondary">{t("verification.loading")}</div>;
  }

  return (
    <div>
      {/* Filter tabs */}
      <div className="mb-4 flex gap-2">
        {(["all", "pending", "verified", "failed"] as const).map((f) => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className={`rounded-md px-3 py-1.5 text-xs font-medium ${
              filter === f
                ? "bg-agent text-white"
                : "bg-background text-text-secondary hover:text-text-primary"
            }`}
          >
            {t(`verification.${f}` as any)} ({counts[f]})
          </button>
        ))}
      </div>

      {/* Table */}
      {filtered.length === 0 ? (
        <div className="py-8 text-center text-sm text-text-secondary">
          {t("verification.none")}
        </div>
      ) : (
        <div className="overflow-hidden rounded-lg border border-border-soft">
          <table className="w-full text-left text-xs">
            <thead className="bg-background text-text-secondary">
              <tr>
                <th className="px-4 py-2 font-medium">{t("verification.candidate")}</th>
                <th className="px-4 py-2 font-medium">{t("verification.type")}</th>
                <th className="px-4 py-2 font-medium">{t("verification.status")}</th>
                <th className="px-4 py-2 font-medium">{t("verification.verifiedAt")}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border-soft">
              {filtered.map((entry) => (
                <tr key={entry.candidate_id} className="hover:bg-background/50">
                  <td className="px-4 py-2">
                    <div className="font-medium text-text-primary">{entry.full_name}</div>
                    <div className="text-text-secondary">{entry.candidate_id}</div>
                  </td>
                  <td className="px-4 py-2 text-text-secondary">{entry.verification_type}</td>
                  <td className="px-4 py-2">
                    <span
                      className={`inline-flex rounded-full px-2 py-0.5 text-[10px] font-medium ${
                        entry.status === "verified"
                          ? "bg-success/20 text-success"
                          : entry.status === "failed"
                          ? "bg-danger/20 text-danger"
                          : "bg-warning/20 text-warning"
                      }`}
                    >
                      {entry.status}
                    </span>
                  </td>
                  <td className="px-4 py-2 text-text-secondary">
                    {entry.verified_at ? new Date(entry.verified_at).toLocaleDateString() : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
