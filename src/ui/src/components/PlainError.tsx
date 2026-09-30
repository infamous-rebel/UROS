/**
 * Quest 05 Part 9 — PlainError component.
 * Maps HTTP status + error codes to plain-language sentences.
 * Never shows raw error objects, stack traces, or class names.
 */

import { useState } from "react";
import { getIcon } from "./navigation/iconRegistry";
import { Icon } from "./navigation/Icon";

interface PlainErrorProps {
  /** HTTP status code */
  status?: number;
  /** Error code string (e.g., "INVALID_CREDENTIALS") */
  code?: string;
  /** Original error message (for developer details only) */
  message?: string;
  /** Request ID for support reference */
  requestId?: string;
  /** Inline or block display */
  inline?: boolean;
}

const STATUS_MESSAGES: Record<number, string> = {
  400: "The information provided is not valid. Please check and try again.",
  401: "Your session has expired. Please log in again.",
  403: "You do not have permission to do this.",
  404: "This item could not be found.",
  409: "This action conflicts with the current state. Please refresh and try again.",
  422: "The data provided does not meet the rules.",
  429: "Too many requests. Please wait a moment.",
  500: "Something went wrong on our side.",
  502: "The server received an invalid response. Please try again shortly.",
  503: "The service is temporarily unavailable. Please try again shortly.",
  504: "The request timed out. Please try again in a moment.",
};

export function PlainError({ status, code, message, requestId, inline = false }: PlainErrorProps) {
  const [showDetails, setShowDetails] = useState(false);

  const plainMessage = status ? STATUS_MESSAGES[status] : null;
  const displayMessage = plainMessage ?? message ?? "An unexpected error occurred.";

  const containerClass = inline
    ? "inline-flex items-center gap-1.5 text-xs text-danger"
    : "rounded-lg border border-danger/20 bg-danger/5 p-4";

  return (
    <div className={containerClass}>
      {!inline && <Icon icon={getIcon("AlertTriangle")} size={18} tone="attention" className="flex-shrink-0" />}
      <div className={inline ? "" : "flex-1"}>
        <p className="text-text-primary">{displayMessage}</p>

        {/* Request ID with copy button */}
        {requestId && (
          <div className="mt-2 flex items-center gap-2">
            <span className="text-xs text-text-secondary">Reference:</span>
            <code className="rounded bg-background px-1.5 py-0.5 font-mono text-xs text-text-primary">
              {requestId}
            </code>
            <button
              onClick={() => {
                navigator.clipboard.writeText(requestId);
              }}
              className="text-xs text-agent hover:underline"
              title="Copy reference ID"
            >
              Copy
            </button>
          </div>
        )}

        {/* Developer details (hidden by default) */}
        {message && message !== displayMessage && (
          <button
            onClick={() => setShowDetails((s) => !s)}
            className="mt-1 text-[10px] text-text-secondary hover:text-text-primary"
          >
            {showDetails ? "Hide details" : "Details"}
          </button>
        )}
        {showDetails && message && (
          <pre className="mt-1 max-h-32 overflow-auto rounded bg-background p-2 font-mono text-[10px] text-text-secondary">
            {message}
          </pre>
        )}
      </div>
    </div>
  );
}

/** Map an Error or Response to PlainError props */
export function errorToPlainError(err: unknown, requestId?: string): PlainErrorProps {
  if (err instanceof Response) {
    return { status: err.status, requestId };
  }
  if (err instanceof Error) {
    // Try to extract status from message
    const match = err.message.match(/(\d{3})/);
    const status = match ? parseInt(match[1], 10) : undefined;
    return { status, message: err.message, requestId };
  }
  return { message: String(err), requestId };
}
