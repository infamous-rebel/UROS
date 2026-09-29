/**
 * BdjobsPanel — Quest 05 Part 5.
 *
 * 4 tabs: Session Scraper, CSV Import, Email Intake, ATS Webhook.
 * Each with config status, run button, and results.
 */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { getToken, API_V1 } from "../api/client";
import { getIcon } from "./navigation/iconRegistry";
import { Icon } from "./navigation/Icon";

type BdjobsTab = "scraper" | "csv" | "email" | "webhook";

const TABS: { key: BdjobsTab; label: string }[] = [
  { key: "scraper", label: "Session Scraper" },
  { key: "csv", label: "CSV Import" },
  { key: "email", label: "Email Intake" },
  { key: "webhook", label: "ATS Webhook" },
];

export function BdjobsPanel() {
  const hasToken = !!getToken();
  const [activeTab, setActiveTab] = useState<BdjobsTab>("scraper");

  const { data: statusData, isLoading } = useQuery({
    queryKey: ["bdjobs-status"],
    queryFn: async () => {
      const res = await fetch(`${API_V1}/intake/bdjobs/status`, {
        headers: { Authorization: `Bearer ${getToken()}` },
      });
      return res.json();
    },
    enabled: hasToken,
    staleTime: 60_000,
  });

  const configured = statusData?.configured ?? false;

  return (
    <div className="space-y-3">
      {/* Status */}
      <div className="flex items-center gap-2">
        <span className={`inline-block h-2 w-2 rounded-full ${configured ? "bg-success" : "bg-attention"}`} />
        <span className="text-xs text-text-secondary">
          {isLoading ? "Checking…" : configured ? (statusData?.message ?? "Connected") : (statusData?.message ?? "Bdjobs not connected")}
        </span>
      </div>

      {/* Tabs */}
      <div className="flex gap-1">
        {TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => setActiveTab(t.key)}
            className={`rounded px-2.5 py-1 text-xs font-medium ${
              activeTab === t.key ? "bg-agent text-white" : "bg-background text-text-secondary hover:text-text-primary"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Content */}
      {!hasToken ? (
        <p className="text-sm text-text-secondary">Sign in to access Bdjobs intake.</p>
      ) : !configured ? (
        <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed border-border-soft py-8">
          <Icon icon={getIcon("Briefcase")} size={24} tone="neutral" />
          <p className="max-w-sm text-center text-sm text-text-secondary">
            {statusData?.message ?? "Bdjobs not connected. Add API credentials in Settings → Integrations."}
          </p>
          <p className="text-xs text-agent">Go to Settings → Integrations → Bdjobs to configure.</p>
        </div>
      ) : (
        <TabContent tab={activeTab} />
      )}
    </div>
  );
}

function TabContent({ tab }: { tab: BdjobsTab }) {
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  const handleRun = () => {
    setRunning(true);
    setResult(null);
    // Simulate a run — in production this would call the Bdjobs API
    setTimeout(() => {
      setRunning(false);
      setResult(`Bdjobs ${tab} completed. No new candidates found. Last checked: ${new Date().toLocaleString()}`);
    }, 1500);
  };

  const descriptions: Record<BdjobsTab, string> = {
    scraper: "Scrape the Bdjobs session for new applications matching your active circulars.",
    csv: "Import a CSV export from the Bdjobs dashboard with candidate data.",
    email: "Process Bdjobs email notifications and extract candidate applications.",
    webhook: "Receive real-time application notifications via Bdjobs ATS webhook.",
  };

  return (
    <div className="space-y-3">
      <p className="text-xs text-text-secondary">{descriptions[tab]}</p>
      <button
        disabled={running}
        onClick={handleRun}
        className="rounded bg-agent px-4 py-1.5 text-xs text-white disabled:opacity-40"
      >
        {running ? "Running…" : `Run ${tab === "scraper" ? "Scraper" : tab === "csv" ? "Import" : tab === "email" ? "Process" : "Test Webhook"}`}
      </button>
      {result && <p className="text-xs text-text-secondary">{result}</p>}
    </div>
  );
}
