/**
 * Quest 05 Part 8b — Breadcrumb navigation.
 * Shows current location: Group > Item
 */

import type { NavItemId } from "../../config/navConfig";
import { findNavItem, findNavGroup } from "../../config/navConfig";

interface BreadcrumbProps {
  activeItem: NavItemId;
  onItemClick: (id: NavItemId) => void;
}

export function Breadcrumb({ activeItem, onItemClick }: BreadcrumbProps) {
  const item = findNavItem(activeItem);
  const group = findNavGroup(activeItem);

  if (!item || !group) return null;

  return (
    <nav className="flex items-center gap-2 text-xs text-text-secondary">
      <button
        onClick={() => {
          // Navigate to first item in group
          const firstItem = group.items[0];
          if (firstItem) onItemClick(firstItem.id);
        }}
        className="hover:text-text-primary"
      >
        {group.label}
      </button>
      <span className="text-text-secondary/50">›</span>
      <span className="text-text-primary font-medium">{item.label}</span>
    </nav>
  );
}
