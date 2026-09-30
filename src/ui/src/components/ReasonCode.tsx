/**
 * Quest 05 Part 9 — ReasonCode component.
 * Displays a reason code as a colored badge. On click/hover, expands to
 * show the full plain-language sentence + "Why?" evidence panel.
 * Never shows the raw code as the primary label (only subtly in the "Why?" panel).
 */

import { useState } from "react";
import { lookupReasonCode, getReasonToneClass } from "../lib/reasonCodes";
import { getIcon } from "./navigation/iconRegistry";
import { Icon } from "./navigation/Icon";

interface ReasonCodeProps {
  code: string | null | undefined;
  /** Optional request_id for support reference */
  requestId?: string;
  size?: "sm" | "md";
}

export function ReasonCode({ code, requestId, size = "md" }: ReasonCodeProps) {
  const [expanded, setExpanded] = useState(false);
  const entry = lookupReasonCode(code);

  // Unknown code — show fallback
  if (!entry) {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-background px-2 py-0.5 text-xs text-text-secondary">
        <Icon icon={getIcon("AlertTriangle")} size={12} tone="attention" />
        <span>Unknown reason</span>
        {requestId && (
          <span className="text-text-secondary">
            — please share reference <code className="font-mono">{requestId}</code> with support
          </span>
        )}
      </span>
    );
  }

  const toneClass = getReasonToneClass(entry.tone);
  const sizeClass = size === "sm" ? "px-2 py-0.5 text-xs" : "px-2.5 py-1 text-xs";

  return (
    <span className="inline-flex flex-col">
      {/* Badge — clickable to expand */}
      <button
        onClick={() => setExpanded((e) => !e)}
        className={`inline-flex cursor-pointer items-center gap-1 rounded-full font-medium transition-colors hover:opacity-80 ${toneClass} ${sizeClass}`}
        title={entry.full_sentence}
      >
        {entry.short_label}
        <Icon icon={getIcon(expanded ? "ChevronUp" : "ChevronDown")} size={10} tone="neutral" />
      </button>

      {/* Expanded panel */}
      {expanded && (
        <div className="mt-1 rounded-md border border-border-soft bg-surface p-2.5 text-xs shadow-sm">
          <p className="text-text-primary">{entry.full_sentence}</p>
          <details className="mt-1.5">
            <summary className="cursor-pointer text-agent font-medium">Why?</summary>
            <p className="mt-1 text-text-secondary">{entry.why}</p>
            <p className="mt-1 font-mono text-[10px] text-text-secondary">
              Code: {entry.code}
            </p>
          </details>
        </div>
      )}
    </span>
  );
}
