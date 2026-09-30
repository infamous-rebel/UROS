/**
 * Quest 05 Part 9 — Toast notification system.
 * Success toasts auto-dismiss after 4s. Error toasts stay until dismissed.
 * Max 5 visible, stacking. Every toast includes a "Details" link for dev-only view.
 */

import { useState, useCallback, createContext, useContext } from "react";
import { getIcon } from "./navigation/iconRegistry";
import { Icon } from "./navigation/Icon";

export type ToastType = "success" | "error" | "warning";

export interface Toast {
  id: string;
  type: ToastType;
  message: string;
  /** Developer-only detail (logged, not prominently shown) */
  detail?: string;
  /** Auto-dismiss after N ms (0 = stay until dismissed) */
  autoDismiss: number;
}

interface ToastContextValue {
  toasts: Toast[];
  showToast: (type: ToastType, message: string, detail?: string) => void;
  dismissToast: (id: string) => void;
  dismissAll: () => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

let toastIdCounter = 0;

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const dismissToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const dismissAll = useCallback(() => {
    setToasts([]);
  }, []);

  const showToast = useCallback(
    (type: ToastType, message: string, detail?: string) => {
      const id = `toast-${++toastIdCounter}`;
      const autoDismiss = type === "success" ? 4000 : 0;

      const toast: Toast = { id, type, message, detail, autoDismiss };
      setToasts((prev) => {
        const next = [...prev, toast];
        // Max 5 visible — remove oldest
        return next.length > 5 ? next.slice(-5) : next;
      });

      // Auto-dismiss timer
      if (autoDismiss > 0) {
        setTimeout(() => dismissToast(id), autoDismiss);
      }
    },
    [dismissToast]
  );

  return (
    <ToastContext.Provider value={{ toasts, showToast, dismissToast, dismissAll }}>
      {children}
      <ToastContainer />
    </ToastContext.Provider>
  );
}

export function useToast() {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be used within ToastProvider");
  return ctx;
}

function ToastContainer() {
  const ctx = useContext(ToastContext);
  if (!ctx) return null;
  const { toasts, dismissToast } = ctx;

  if (toasts.length === 0) return null;

  return (
    <div className="fixed bottom-4 right-4 z-[100] flex flex-col gap-2">
      {toasts.map((toast) => (
        <ToastItem key={toast.id} toast={toast} onDismiss={() => dismissToast(toast.id)} />
      ))}
    </div>
  );
}

function ToastItem({ toast, onDismiss }: { toast: Toast; onDismiss: () => void }) {
  const [showDetail, setShowDetail] = useState(false);

  const iconMap = {
    success: getIcon("Check"),
    error: getIcon("AlertTriangle"),
    warning: getIcon("AlertTriangle"),
  };

  const toneMap = {
    success: "border-success/30 bg-success/5",
    error: "border-danger/30 bg-danger/5",
    warning: "border-attention/30 bg-attention/5",
  };

  const iconToneMap = {
    success: "system" as const,
    error: "attention" as const,
    warning: "attention" as const,
  };

  return (
    <div
      className={`flex min-w-[280px] max-w-[400px] items-start gap-2 rounded-lg border p-3 shadow-lg ${toneMap[toast.type]}`}
    >
      <Icon icon={iconMap[toast.type]} size={16} tone={iconToneMap[toast.type]} className="mt-0.5 flex-shrink-0" />
      <div className="flex-1 text-sm text-text-primary">{toast.message}</div>
      <div className="flex flex-col items-end gap-1">
        <button
          onClick={onDismiss}
          className="text-text-secondary hover:text-text-primary"
          aria-label="Dismiss"
        >
          <Icon icon={getIcon("X")} size={14} tone="neutral" />
        </button>
        {toast.detail && (
          <button
            onClick={() => setShowDetail((s) => !s)}
            className="text-[10px] text-text-secondary hover:text-agent"
          >
            {showDetail ? "Hide" : "Details"}
          </button>
        )}
      </div>
      {showDetail && toast.detail && (
        <div className="absolute bottom-0 left-0 right-0 rounded-b-lg border-t border-border-soft bg-background p-2 font-mono text-[10px] text-text-secondary">
          {toast.detail}
        </div>
      )}
    </div>
  );
}
