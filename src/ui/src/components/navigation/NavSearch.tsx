/**
 * Quest 05 Part 8b/8c — Navigation search input.
 * Filters visible nav items in real time.
 */

import { useRef, useEffect } from "react";
import { getIcon } from "./iconRegistry";
import { Icon } from "./Icon";

interface NavSearchProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
}

export function NavSearch({ value, onChange, placeholder = "Search navigation..." }: NavSearchProps) {
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      onChange("");
      inputRef.current?.blur();
    }
  };

  const SearchIcon = getIcon("Search");
  const XIcon = getIcon("X");

  return (
    <div className="relative">
      <Icon icon={SearchIcon} size={14} tone="neutral" className="absolute left-2.5 top-1/2 -translate-y-1/2" />
      <input
        ref={inputRef}
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={placeholder}
        className="w-full rounded-md border border-border-soft bg-background pl-8 pr-7 py-1.5 text-xs text-text-primary placeholder:text-text-secondary focus:border-agent focus:outline-none"
      />
      {value && (
        <button
          onClick={() => onChange("")}
          className="absolute right-2 top-1/2 -translate-y-1/2 text-text-secondary hover:text-text-primary"
          aria-label="Clear search"
        >
          <Icon icon={XIcon} size={14} tone="neutral" />
        </button>
      )}
    </div>
  );
}
