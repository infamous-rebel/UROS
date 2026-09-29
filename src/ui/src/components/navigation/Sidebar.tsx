/**
 * Quest 05 Part 8b — Main sidebar container.
 * Responsive: 240px expanded, 64px collapsed, drawer on mobile.
 */

import { useState, useEffect } from "react";
import type { NavItemId } from "../../config/navConfig";
import { filterNavByRole } from "../../config/navConfig";
import { NavGroup } from "./NavGroup";
import { NavSearch } from "./NavSearch";
import { useAuth } from "../../auth/AuthContext";

interface SidebarProps {
  activeItem: NavItemId;
  collapsed: boolean;
  pinned: NavItemId[];
  recent: NavItemId[];
  onItemClick: (id: NavItemId) => void;
  onPin: (id: NavItemId) => void;
  onToggleCollapse: () => void;
  mobileOpen: boolean;
  onMobileClose: () => void;
  badgeOverrides?: Partial<Record<NavItemId, number>>;
}

export function Sidebar({
  activeItem,
  collapsed,
  pinned,
  recent,
  onItemClick,
  onPin,
  onToggleCollapse,
  mobileOpen,
  onMobileClose,
  badgeOverrides,
}: SidebarProps) {
  const [searchQuery, setSearchQuery] = useState("");
  const { user } = useAuth();
  const userRole = user?.role ?? "RECRUITER";

  // Filter nav by role and apply badge overrides
  const navGroups = filterNavByRole(userRole).map((group) => ({
    ...group,
    items: group.items.map((item) => ({
      ...item,
      badge: badgeOverrides?.[item.id] ?? item.badge,
    })),
  }));

  // Close mobile drawer on navigation
  useEffect(() => {
    if (mobileOpen) {
      onMobileClose();
    }
  }, [activeItem]);

  // Get pinned items that exist in nav config
  const pinnedItems = navGroups
    .flatMap((g) => g.items)
    .filter((item) => pinned.includes(item.id));

  // Get recent items that exist in nav config and aren't pinned
  const recentItems = navGroups
    .flatMap((g) => g.items)
    .filter((item) => recent.includes(item.id) && !pinned.includes(item.id))
    .slice(0, 5);

  // Force expand on mobile when drawer is open
  const isCollapsed = mobileOpen ? false : collapsed;
  const sidebarWidth = isCollapsed ? "w-16" : "w-60";

  return (
    <>
      {/* Mobile backdrop */}
      {mobileOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/50 lg:hidden"
          onClick={onMobileClose}
        />
      )}

      {/* Sidebar */}
      <aside
        className={`fixed left-0 top-0 z-50 flex h-full flex-col border-r border-border-soft bg-surface transition-all duration-200 lg:relative lg:z-0 ${sidebarWidth} ${
          mobileOpen ? "translate-x-0" : "-translate-x-full lg:translate-x-0"
        }`}
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-border-soft p-3">
          {!isCollapsed && (
            <span className="text-sm font-semibold text-text-primary">UROS</span>
          )}
          <button
            onClick={onToggleCollapse}
            className="rounded p-1 text-text-secondary hover:bg-background hover:text-text-primary"
            title={isCollapsed ? "Expand sidebar" : "Collapse sidebar"}
          >
            {isCollapsed ? "→" : "←"}
          </button>
        </div>

        {/* Search (hidden when collapsed) */}
        {!isCollapsed && (
          <div className="border-b border-border-soft p-3">
            <NavSearch
              value={searchQuery}
              onChange={setSearchQuery}
              placeholder="Search navigation..."
            />
          </div>
        )}

        {/* Navigation content */}
        <div className="flex-1 overflow-y-auto p-2">
          {/* Pinned section */}
          {pinnedItems.length > 0 && !searchQuery && (
            <div className="mb-3">
              {!isCollapsed && (
                <div className="px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-text-secondary">
                  ★ PINNED
                </div>
              )}
              <div className="space-y-0.5">
                {pinnedItems.map((item) => (
                  <div
                    key={item.id}
                    role="button"
                    tabIndex={0}
                    onClick={() => onItemClick(item.id)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        onItemClick(item.id);
                      }
                    }}
                    className={`group relative flex cursor-pointer items-center rounded-md px-3 py-2 text-xs font-medium transition-colors ${
                      activeItem === item.id
                        ? "border-l-4 border-agent bg-agent/10 text-text-primary"
                        : "text-text-secondary hover:bg-background hover:text-text-primary"
                    }`}
                  >
                    <span className="flex-shrink-0 text-base">{item.icon}</span>
                    {!isCollapsed && (
                      <span className="ml-3 flex-1 truncate">{item.label}</span>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Recent section (shown when no pinned) */}
          {pinnedItems.length === 0 && recentItems.length > 0 && !searchQuery && (
            <div className="mb-3">
              {!isCollapsed && (
                <div className="px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-text-secondary">
                  RECENT
                </div>
              )}
              <div className="space-y-0.5">
                {recentItems.map((item) => (
                  <div
                    key={item.id}
                    role="button"
                    tabIndex={0}
                    onClick={() => onItemClick(item.id)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        onItemClick(item.id);
                      }
                    }}
                    className={`group relative flex cursor-pointer items-center rounded-md px-3 py-2 text-xs font-medium transition-colors ${
                      activeItem === item.id
                        ? "border-l-4 border-agent bg-agent/10 text-text-primary"
                        : "text-text-secondary hover:bg-background hover:text-text-primary"
                    }`}
                  >
                    <span className="flex-shrink-0 text-base">{item.icon}</span>
                    {!isCollapsed && (
                      <span className="ml-3 flex-1 truncate">{item.label}</span>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Nav groups */}
          {navGroups.map((group) => (
            <NavGroup
              key={group.id}
              group={group}
              activeItem={activeItem}
              collapsed={isCollapsed}
              pinned={pinned}
              searchQuery={searchQuery}
              onItemClick={onItemClick}
              onItemPin={onPin}
            />
          ))}
        </div>

        {/* Footer - user info (hidden when collapsed) */}
        {!isCollapsed && (
          <div className="border-t border-border-soft p-3">
            <div className="flex items-center gap-2">
              <div className="flex h-6 w-6 items-center justify-center rounded-full bg-agent text-[10px] font-semibold text-white">
                {user?.email?.[0]?.toUpperCase() ?? "U"}
              </div>
              <div className="flex-1 truncate text-xs text-text-secondary">
                {user?.email ?? "Unknown"}
              </div>
            </div>
          </div>
        )}
      </aside>
    </>
  );
}
