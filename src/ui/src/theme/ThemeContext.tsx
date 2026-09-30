/**
 * Quest 05 Part 14 — Theme provider for Light / Dark / System mode.
 *
 * Theme preference is persisted server-side (users.theme_preference) and
 * loaded on login. Falls back to localStorage, then system preference.
 * Applies instantly via data-theme attribute on <html> — no page reload.
 */
import { createContext, useContext, useEffect, useState, useCallback } from "react";

export type ThemeMode = "light" | "dark" | "system";

interface ThemeContextValue {
  mode: ThemeMode;
  resolved: "light" | "dark";
  setMode: (mode: ThemeMode) => void;
}

const ThemeContext = createContext<ThemeContextValue>({
  mode: "system",
  resolved: "light",
  setMode: () => {},
});

function getSystemTheme(): "light" | "dark" {
  if (typeof window === "undefined") return "light";
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function resolveTheme(mode: ThemeMode): "light" | "dark" {
  if (mode === "system") return getSystemTheme();
  return mode;
}

function applyTheme(resolved: "light" | "dark") {
  document.documentElement.setAttribute("data-theme", resolved);
}

export function ThemeProvider({ children, initialMode }: { children: React.ReactNode; initialMode?: ThemeMode }) {
  const [mode, setModeState] = useState<ThemeMode>(() => {
    if (initialMode && ["light", "dark", "system"].includes(initialMode)) return initialMode;
    // Try localStorage
    const stored = localStorage.getItem("uros-theme") as ThemeMode | null;
    if (stored && ["light", "dark", "system"].includes(stored)) return stored;
    return "system";
  });

  const resolved = resolveTheme(mode);

  // Apply theme to DOM
  useEffect(() => {
    applyTheme(resolved);
    localStorage.setItem("uros-theme", mode);
  }, [resolved, mode]);

  // Listen for system theme changes when in "system" mode
  useEffect(() => {
    if (mode !== "system") return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const handler = () => applyTheme(getSystemTheme());
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, [mode]);

  const setMode = useCallback((newMode: ThemeMode) => {
    setModeState(newMode);
    // Persist to server (fire-and-forget)
    persistTheme(newMode);
  }, []);

  return (
    <ThemeContext.Provider value={{ mode, resolved, setMode }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  return useContext(ThemeContext);
}

/** Persist theme preference to server (best-effort). */
async function persistTheme(mode: ThemeMode) {
  try {
    const { authedRequest, API_V1 } = await import("../api/client");
    await authedRequest(`${API_V1}/settings/me/profile`, {
      method: "PATCH",
      body: JSON.stringify({ theme_preference: mode }),
    });
  } catch {
    // Silent — localStorage already has the value
  }
}
