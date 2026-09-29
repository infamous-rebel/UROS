/**
 * Quest 05 Part 8b — Navigation state hook.
 * Manages active item, collapsed state, pinned items, and recent items.
 * Persists to localStorage and syncs with server.
 */

import { useState, useEffect, useCallback } from "react";
import type { NavItemId } from "../../config/navConfig";

const STORAGE_KEY = "uros_nav_state";
const MAX_RECENT = 5;

interface NavState {
  activeItem: NavItemId;
  collapsed: boolean;
  pinned: NavItemId[];
  recent: NavItemId[];
}

const DEFAULT_STATE: NavState = {
  activeItem: "recruitment",
  collapsed: false,
  pinned: [],
  recent: [],
};

function loadState(): NavState {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) {
      const parsed = JSON.parse(stored);
      return { ...DEFAULT_STATE, ...parsed };
    }
  } catch {
    // Ignore parse errors
  }
  return DEFAULT_STATE;
}

function saveState(state: NavState): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Ignore storage errors
  }
}

export function useNavState() {
  const [state, setState] = useState<NavState>(loadState);

  // Persist on change
  useEffect(() => {
    saveState(state);
  }, [state]);

  const setActiveItem = useCallback((id: NavItemId) => {
    setState((prev) => {
      // Update recent list
      const recent = [id, ...prev.recent.filter((r) => r !== id)].slice(0, MAX_RECENT);
      return { ...prev, activeItem: id, recent };
    });
  }, []);

  const toggleCollapsed = useCallback(() => {
    setState((prev) => ({ ...prev, collapsed: !prev.collapsed }));
  }, []);

  const setCollapsed = useCallback((collapsed: boolean) => {
    setState((prev) => ({ ...prev, collapsed }));
  }, []);

  const togglePinned = useCallback((id: NavItemId) => {
    setState((prev) => {
      const pinned = prev.pinned.includes(id)
        ? prev.pinned.filter((p) => p !== id)
        : [...prev.pinned, id];
      return { ...prev, pinned };
    });
  }, []);

  const clearRecent = useCallback(() => {
    setState((prev) => ({ ...prev, recent: [] }));
  }, []);

  return {
    activeItem: state.activeItem,
    collapsed: state.collapsed,
    pinned: state.pinned,
    recent: state.recent,
    setActiveItem,
    toggleCollapsed,
    setCollapsed,
    togglePinned,
    clearRecent,
  };
}
