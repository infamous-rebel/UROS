/**
 * Quest 05 Part 9 — Rich empty states.
 * Every list, table, and panel shows a contextual message, optional 24h stat,
 * and optional action button. Never a bare "No data".
 */
import { getIcon } from "./navigation/iconRegistry";
import { Icon } from "./navigation/Icon";

interface EmptyStateProps {
  message: string;
  stat?: string;
  actionLabel?: string;
  onAction?: () => void;
  icon?: string;
  tone?: "neutral" | "danger" | "success";
}

export function EmptyState({ message, stat, actionLabel, onAction, icon, tone = "neutral" }: EmptyStateProps) {
  const color = tone === "danger" ? "text-danger" : tone === "success" ? "text-success" : "text-text-secondary";
  const IconComp = icon ? getIcon(icon) : null;
  return (
    <div className="flex flex-1 flex-col items-center justify-center rounded-lg border-2 border-dashed border-border-soft py-10 text-center">
      {IconComp && (
        <div className="mb-3 rounded-full bg-border-soft/40 p-3">
          <Icon name={icon!} size={24} className="text-text-secondary" />
        </div>
      )}
      <p className={`px-4 text-sm font-medium ${color}`}>{message}</p>
      {stat && <p className="mt-1 px-4 text-xs text-text-secondary">{stat}</p>}
      {actionLabel && onAction && (
        <button
          onClick={onAction}
          className="mt-4 rounded-md bg-agent px-4 py-2 text-xs font-medium text-white hover:opacity-90"
        >
          {actionLabel}
        </button>
      )}
    </div>
  );
}
