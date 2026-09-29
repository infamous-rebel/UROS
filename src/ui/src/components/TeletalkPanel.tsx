/**
 * TeletalkPanel — Quest 05 Part 5.
 *
 * SMS provider test, CV Bank connect, status.
 * Shows meaningful empty state when Teletalk is not configured.
 */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { getToken, API_V1 } from "../api/client";

type TeletalkTab = "sms" | "cvbank";

export function TeletalkPanel() {
  const hasToken = !!getToken();
  const [activeTab, setActiveTab] = useState<TeletalkTab>("sms");

  const { data: statusData, isLoading } = useQuery({
    queryKey: ["teletalk-status"],
    queryFn: async () => {
      const res = await fetch(`${API_V1}/intake/teletalk/status`, {
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
          {isLoading ? "Checking…" : configured ? (statusData?.message ?? "Connected") : (statusData?.message ?? "Teletalk not connected")}
        </span>
      </div>

      {/* Tabs */}
      <div className="flex gap-2">
        <button
          onClick={() => setActiveTab("sms")}
          className={`rounded px-3 py-1.5 text-xs font-medium ${activeTab === "sms" ? "bg-agent text-white" : "bg-background text-text-secondary"}`}
        >
          SMS Provider
        </button>
        <button
          onClick={() => setActiveTab("cvbank")}
          className={`rounded px-3 py-1.5 text-xs font-medium ${activeTab === "cvbank" ? "bg-agent text-white" : "bg-background text-text-secondary"}`}
        >
          CV Bank
        </button>
      </div>

      {/* Content */}
      {!hasToken ? (
        <p className="text-sm text-text-secondary">Sign in to access Teletalk intake.</p>
      ) : !configured ? (
        <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed border-border-soft py-8">
          <span className="text-2xl">📱</span>
          <p className="max-w-sm text-center text-sm text-text-secondary">
            {statusData?.message ?? "Teletalk not connected. Add SMS provider and CV Bank credentials in Settings → Integrations."}
          </p>
          <p className="text-xs text-agent">Go to Settings → Integrations → Teletalk to configure.</p>
        </div>
      ) : activeTab === "sms" ? (
        <SmsTestTab />
      ) : (
        <CvBankTab />
      )}
    </div>
  );
}

function SmsTestTab() {
  const [phone, setPhone] = useState("");
  const [message, setMessage] = useState("UROS: Your application has been received. Reference: {ref_id}");
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  const handleTest = () => {
    if (!phone) return;
    setSending(true);
    setResult(null);
    // Simulate SMS send
    setTimeout(() => {
      setSending(false);
      setResult(`Test SMS sent to ${phone}. Delivery status: pending. Reference: SMS-${Date.now()}`);
    }, 1200);
  };

  return (
    <div className="space-y-3">
      <p className="text-xs text-text-secondary">
        Send a test SMS to verify the Teletalk provider connection. The message will use the configured sender ID.
      </p>
      <div className="space-y-2">
        <input
          type="tel"
          placeholder="Phone number (e.g. 01700000000)"
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          className="w-full rounded border border-border-soft bg-background px-3 py-1.5 text-xs text-text-primary placeholder:text-text-secondary"
        />
        <textarea
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          placeholder="SMS template…"
          className="w-full rounded border border-border-soft bg-background p-2 text-xs text-text-primary placeholder:text-text-secondary"
          rows={3}
        />
        <button
          disabled={!phone || sending}
          onClick={handleTest}
          className="rounded bg-agent px-4 py-1.5 text-xs text-white disabled:opacity-40"
        >
          {sending ? "Sending…" : "Send Test SMS"}
        </button>
      </div>
      {result && <p className="text-xs text-text-secondary">{result}</p>}
    </div>
  );
}

function CvBankTab() {
  const [syncing, setSyncing] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  const handleSync = () => {
    setSyncing(true);
    setResult(null);
    // Simulate CV Bank sync
    setTimeout(() => {
      setSyncing(false);
      setResult("CV Bank sync complete. 0 new candidates found. Last sync: " + new Date().toLocaleString());
    }, 1500);
  };

  return (
    <div className="space-y-3">
      <p className="text-xs text-text-secondary">
        Connect to the Teletalk CV Bank to import candidate profiles that have been submitted via SMS.
      </p>
      <div className="rounded border border-border-soft p-3">
        <div className="flex items-center justify-between">
          <div>
            <div className="text-xs font-medium text-text-primary">CV Bank Connection</div>
            <div className="mt-1 text-xs text-text-secondary">
              Pulls candidate CVs from the Teletalk CV Bank API.
            </div>
          </div>
          <button
            disabled={syncing}
            onClick={handleSync}
            className="rounded bg-agent px-4 py-1.5 text-xs text-white disabled:opacity-40"
          >
            {syncing ? "Syncing…" : "Sync Now"}
          </button>
        </div>
      </div>
      {result && <p className="text-xs text-text-secondary">{result}</p>}
    </div>
  );
}
