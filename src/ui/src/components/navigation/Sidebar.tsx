/**
 * Quest 05 Part 8b/8c — Main sidebar container.
 * Responsive: 240px expanded, 64px collapsed, drawer on mobile.
 */

import { useState, useEffect } from "react";
import { getIcon } from "./iconRegistry";
import { Icon } from "./Icon";
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

  const navGroups = filterNavByRole(userRole).map((group) => ({
    ...group,
    items: group.items.map((item) => ({
      ...item,
      badge: badgeOverrides?.[item.id] ?? item.badge,
    })),
  }));

  useEffect(() => {
    if (mobileOpen) {
      onMobileClose();
    }
  }, [activeItem]);

  const pinnedItems = navGroups
    .flatMap((g) => g.items)
    .filter((item) => pinned.includes(item.id));

  const recentItems = navGroups
    .flatMap((g) => g.items)
    .filter((item) => recent.includes(item.id) && !pinned.includes(item.id))
    .slice(0, 5);

  const isCollapsed = mobileOpen ? false : collapsed;
  const sidebarWidth = isCollapsed ? "w-16" : "w-60";

  const CollapseIcon = getIcon(isCollapsed ? "ChevronsRight" : "ChevronsLeft");
  const StarIcon = getIcon("Star");

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
            <Icon icon={CollapseIcon} size={18} tone="neutral" />
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
                <div className="flex items-center px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-text-secondary">
                  <Icon icon={StarIcon} size={10} tone="attention" className="mr-1" />
                  PINNED
                </div>
              )}
              <div className="space-y-0.5">
                {pinnedItems.map((item) => {
                  const ItemIcon = getIcon(item.icon);
                  return (
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
                      <Icon icon={ItemIcon} size={20} tone="neutral" className="flex-shrink-0" />
                      {!isCollapsed && (
                        <span className="ml-3 flex-1 truncate">{item.label}</span>
                      )}
                    </div>
                  );
                })}
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
                {recentItems.map((item) => {
                  const ItemIcon = getIcon(item.icon);
                  return (
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
                      <Icon icon={ItemIcon} size={20} tone="neutral" className="flex-shrink-0" />
                      {!isCollapsed && (
                        <span className="ml-3 flex-1 truncate">{item.label}</span>
                      )}
                    </div>
                  );
                })}
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
