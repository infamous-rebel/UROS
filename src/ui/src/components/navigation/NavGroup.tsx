/**
 * Quest 05 Part 8b — Collapsible navigation group.
 * Shows group header and items.
 */

import { useState } from "react";
import type { NavGroup as NavGroupType, NavItem as NavItemType } from "../../config/navConfig";
import { NavItem } from "./NavItem";

interface NavGroupProps {
  group: NavGroupType;
  activeItem: NavItemType["id"];
  collapsed: boolean;
  pinned: NavItemType["id"][];
  searchQuery: string;
  onItemClick: (id: NavItemType["id"]) => void;
  onItemPin: (id: NavItemType["id"]) => void;
}

export function NavGroup({
  group,
  activeItem,
  collapsed,
  pinned,
  searchQuery,
  onItemClick,
  onItemPin,
}: NavGroupProps) {
  const [expanded, setExpanded] = useState(true);

  // Filter items by search query
  const filteredItems = searchQuery
    ? group.items.filter((item) =>
        item.label.toLowerCase().includes(searchQuery.toLowerCase())
      )
    : group.items;

  // Hide group if no items match search
  if (filteredItems.length === 0) return null;

  return (
    <div className="mb-2">
      {/* Group header */}
      {!collapsed && (
        <button
          onClick={() => setExpanded(!expanded)}
          className="flex w-full items-center px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-text-secondary hover:text-text-primary"
        >
          <span className="mr-1">{group.icon}</span>
          <span className="flex-1 text-left">{group.label}</span>
          <span className="text-[8px]">{expanded ? "▼" : "▶"}</span>
        </button>
      )}

      {/* Group items */}
      {(expanded || collapsed) && (
        <div className="space-y-0.5">
          {filteredItems.map((item) => (
            <NavItem
              key={item.id}
              item={item}
              active={activeItem === item.id}
              collapsed={collapsed}
              pinned={pinned.includes(item.id)}
              onClick={() => onItemClick(item.id)}
              onPin={() => onItemPin(item.id)}
            />
          ))}
        </div>
      )}
    </div>
  );
}
