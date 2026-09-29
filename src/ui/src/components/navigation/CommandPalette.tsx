/**
 * Quest 05 Part 8b/8c — Command palette (Cmd+K overlay).
 * Full-screen overlay with fuzzy search across routes + candidates + rules + gates + audits.
 */

import { useState, useEffect, useRef, useCallback } from "react";
import { getIcon } from "./iconRegistry";
import { Icon } from "./Icon";
import type { NavItemId } from "../../config/navConfig";
import { getAllNavItems, findNavGroup } from "../../config/navConfig";

interface CommandPaletteProps {
  open: boolean;
  onClose: () => void;
  onNavigate: (id: NavItemId) => void;
}

interface SearchResult {
  type: "nav" | "candidate" | "rule" | "gate" | "audit";
  id: string;
  label: string;
  subtitle?: string;
  navId?: NavItemId;
  iconName?: string;
}

export function CommandPalette({ open, onClose, onNavigate }: CommandPaletteProps) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setQuery("");
      setSelectedIndex(0);
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [open]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && open) {
        onClose();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [open, onClose]);

  const search = useCallback((q: string) => {
    const query = q.toLowerCase().trim();
    const results: SearchResult[] = [];

    const navItems = getAllNavItems();
    for (const item of navItems) {
      if (!query || item.label.toLowerCase().includes(query)) {
        const group = findNavGroup(item.id);
        results.push({
          type: "nav",
          id: item.id,
          label: item.label,
          subtitle: group?.label,
          navId: item.id,
          iconName: item.icon,
        });
      }
    }

    return results.slice(0, 20);
  }, []);

  useEffect(() => {
    setResults(search(query));
    setSelectedIndex(0);
  }, [query, search]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelectedIndex((i) => Math.min(i + 1, results.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelectedIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const selected = results[selectedIndex];
      if (selected?.navId) {
        onNavigate(selected.navId);
        onClose();
      }
    }
  };

  if (!open) return null;

  const CommandIcon = getIcon("Command");

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-[20vh]">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/50 backdrop-blur-sm"
        onClick={onClose}
      />

      {/* Palette */}
      <div className="relative w-full max-w-xl rounded-xl border border-border-soft bg-surface shadow-2xl">
        {/* Search input */}
        <div className="flex items-center gap-2 border-b border-border-soft p-4">
          <Icon icon={getIcon("Search")} size={18} tone="neutral" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Search navigation, candidates, rules, gates, audits..."
            className="w-full bg-transparent text-sm text-text-primary placeholder:text-text-secondary focus:outline-none"
          />
          <Icon icon={CommandIcon} size={14} tone="neutral" className="flex-shrink-0" />
          <span className="text-xs text-text-secondary">K</span>
        </div>

        {/* Results */}
        <div className="max-h-80 overflow-y-auto p-2">
          {results.length === 0 ? (
            <div className="px-4 py-8 text-center text-sm text-text-secondary">
              No results found
            </div>
          ) : (
            <div className="space-y-1">
              {results.map((result, index) => {
                const ResultIcon = getIcon(result.iconName ?? "LayoutDashboard");
                return (
                  <button
                    key={result.id}
                    onClick={() => {
                      if (result.navId) {
                        onNavigate(result.navId);
                        onClose();
                      }
                    }}
                    className={`flex w-full items-center gap-3 rounded-lg px-4 py-2 text-left text-sm ${
                      index === selectedIndex
                        ? "bg-agent/10 text-text-primary"
                        : "text-text-secondary hover:bg-background hover:text-text-primary"
                    }`}
                  >
                    <Icon icon={ResultIcon} size={18} tone={index === selectedIndex ? "system" : "neutral"} />
                    <div className="flex-1">
                      <div className="font-medium">{result.label}</div>
                      {result.subtitle && (
                        <div className="text-xs text-text-secondary">{result.subtitle}</div>
                      )}
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center gap-4 border-t border-border-soft px-4 py-2 text-xs text-text-secondary">
          <span>↑↓ Navigate</span>
          <span>↵ Open</span>
          <span>Esc Close</span>
        </div>
      </div>
    </div>
  );
}
