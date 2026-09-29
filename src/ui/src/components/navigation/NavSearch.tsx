/**
 * Quest 05 Part 8b — Navigation search input.
 * Filters visible nav items in real time.
 */

import { useRef, useEffect } from "react";

interface NavSearchProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
}

export function NavSearch({ value, onChange, placeholder = "Search navigation..." }: NavSearchProps) {
  const inputRef = useRef<HTMLInputElement>(null);

  // Focus on mount
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Esc clears search
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      onChange("");
      inputRef.current?.blur();
    }
  };

  return (
    <div className="relative">
      <input
        ref={inputRef}
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={placeholder}
        className="w-full rounded-md border border-border-soft bg-background px-3 py-1.5 text-xs text-text-primary placeholder:text-text-secondary focus:border-agent focus:outline-none"
      />
      {value && (
        <button
          onClick={() => onChange("")}
          className="absolute right-2 top-1/2 -translate-y-1/2 text-text-secondary hover:text-text-primary"
          aria-label="Clear search"
        >
          ×
        </button>
      )}
    </div>
  );
}
