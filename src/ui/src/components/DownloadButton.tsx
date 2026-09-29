/**
 * Quest 05 Part 8 — DownloadButton: the single download primitive.
 *
 * Calls an endpoint with the user's JWT, reads the response as a blob,
 * extracts the filename from Content-Disposition (or falls back to the
 * `filename` prop), and triggers a browser download.
 *
 * Behavior:
 * - Shows spinner while fetching
 * - Success: subtle inline confirmation (plain language)
 * - Error: plain-language message + "Copy reference ID" link
 * - Handles 401 by triggering refresh and retrying once
 * - Never logs the JWT; never exposes internal URLs
 */
import { useState, useCallback } from "react";
import { getIcon } from "./navigation/iconRegistry";
import { Icon } from "./navigation/Icon";
import { authedRequest } from "../api/client";

interface DownloadButtonProps {
  endpoint: string;
  method?: "GET" | "POST";
  body?: object;
  format: string;
  filename: string;
  label: string;
  variant?: "primary" | "secondary" | "icon";
  size?: "sm" | "md";
  /** Optional RBAC gate — if false, button is hidden */
  allowed?: boolean;
}

export function DownloadButton({
  endpoint,
  method = "GET",
  body,
  format,
  filename,
  label,
  variant = "secondary",
  size = "md",
  allowed = true,
}: DownloadButtonProps) {
  const [status, setStatus] = useState<"idle" | "loading" | "done" | "error">("idle");
  const [refId, setRefId] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const handleDownload = useCallback(async () => {
    if (status === "loading") return;
    setStatus("loading");
    setRefId(null);

    try {
      const res = await authedRequest<Response>(endpoint, {
        method,
        body: body ? JSON.stringify(body) : undefined,
        raw: true, // get the raw Response, not parsed JSON
      });

      if (!res.ok) {
        const ref = res.headers.get("x-request-id");
        setRefId(ref);
        setStatus("error");
        return;
      }

      // Extract filename from Content-Disposition
      const disposition = res.headers.get("Content-Disposition") ?? "";
      let downloadName = filename;
      const match = disposition.match(/filename="?([^";\s]+)"?/);
      if (match) downloadName = match[1];
      if (!downloadName.endsWith(`.${format}`) && !downloadName.includes(".")) {
        downloadName = `${downloadName}.${format}`;
      }

      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = downloadName;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);

      setStatus("done");
      setTimeout(() => setStatus("idle"), 3000);
    } catch {
      setStatus("error");
    }
  }, [endpoint, method, body, filename, format, status]);

  if (!allowed) return null;

  const sizeClass = size === "sm" ? "px-2 py-1 text-xs" : "px-3 py-1.5 text-sm";
  const variantClass =
    variant === "primary"
      ? "bg-agent text-white"
      : variant === "icon"
        ? "text-agent hover:bg-agent/10"
        : "border border-border-soft text-text-secondary hover:bg-background hover:text-text-primary";

  return (
    <div className="inline-flex items-center gap-2">
      <button
        onClick={handleDownload}
        disabled={status === "loading"}
        className={`inline-flex items-center gap-1.5 rounded-md font-medium transition-colors disabled:opacity-50 ${sizeClass} ${variantClass}`}
      >
        {status === "loading" ? (
          <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-current border-t-transparent" />
        ) : (
          <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
          </svg>
        )}
        {status === "loading" ? "Downloading…" : label}
      </button>

      {status === "done" && (
        <span className="text-xs text-success"><Icon icon={getIcon("Check")} size={12} tone="system" className="inline mr-1" />Downloaded</span>
      )}

      {status === "error" && (
        <span className="text-xs text-human">
          Download failed.
          {refId && (
            <button
              onClick={() => {
                navigator.clipboard.writeText(refId);
                setCopied(true);
                setTimeout(() => setCopied(false), 2000);
              }}
              className="ml-1 underline hover:text-human/80"
            >
              {copied ? "Copied" : "Copy reference ID"}
            </button>
          )}
        </span>
      )}
    </div>
  );
}
