/**
 * Quest 05 Part 8b/8c — Collapsible navigation group.
 * Shows group header with Lucide icon and items.
 */

import { useState } from "react";
import { getIcon } from "./iconRegistry";
import { Icon } from "./Icon";
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

  const filteredItems = searchQuery
    ? group.items.filter((item) =>
        item.label.toLowerCase().includes(searchQuery.toLowerCase())
      )
    : group.items;

  if (filteredItems.length === 0) return null;

  const GroupIcon = getIcon(group.icon);
  const ChevronIcon = getIcon(expanded ? "ChevronsLeft" : "ChevronsRight");

  return (
    <div className="mb-2">
      {/* Group header */}
      {!collapsed && (
        <button
          onClick={() => setExpanded(!expanded)}
          className="flex w-full items-center px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-text-secondary hover:text-text-primary"
        >
          <Icon icon={GroupIcon} size={14} tone="neutral" className="mr-1.5" />
          <span className="flex-1 text-left">{group.label}</span>
          <Icon icon={ChevronIcon} size={10} tone="neutral" className={`transition-transform ${expanded ? "rotate-0" : "-rotate-90"}`} />
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
