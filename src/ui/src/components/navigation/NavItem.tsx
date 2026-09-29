/**
 * Quest 05 Part 8b — Single navigation item.
 * Shows icon, label, badge, and star for pinning.
 */

import type { NavItem as NavItemType } from "../../config/navConfig";

interface NavItemProps {
  item: NavItemType;
  active: boolean;
  collapsed: boolean;
  pinned: boolean;
  onClick: () => void;
  onPin: () => void;
}

export function NavItem({ item, active, collapsed, pinned, onClick, onPin }: NavItemProps) {
  const handleClick = () => {
    if (item.external) {
      // External links open in new tab
      window.open("https://skills.uros.local", "_blank", "noopener,noreferrer");
    } else {
      onClick();
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      handleClick();
    }
  };

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={handleClick}
      onKeyDown={handleKeyDown}
      className={`group relative flex cursor-pointer items-center rounded-md px-3 py-2 text-xs font-medium transition-colors ${
        active
          ? "border-l-4 border-agent bg-agent/10 text-text-primary"
          : "text-text-secondary hover:bg-background hover:text-text-primary"
      }`}
    >
      {/* Icon */}
      <span className="flex-shrink-0 text-base">{item.icon}</span>

      {/* Label (hidden when collapsed) */}
      {!collapsed && (
        <span className="ml-3 flex-1 truncate">{item.label}</span>
      )}

      {/* Badge */}
      {item.badge !== undefined && item.badge > 0 && (
        <span className="ml-auto rounded-full bg-warning px-1.5 py-0.5 text-[10px] font-semibold text-white">
          {item.badge}
        </span>
      )}

      {/* External icon */}
      {item.external && !collapsed && (
        <span className="ml-1 text-[10px] text-text-secondary">↗</span>
      )}

      {/* Pin star (visible on hover or if already pinned) */}
      {!collapsed && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            onPin();
          }}
          className={`ml-1 flex-shrink-0 opacity-0 transition-opacity group-hover:opacity-100 ${
            pinned ? "opacity-100 text-warning" : "text-text-secondary hover:text-warning"
          }`}
          aria-label={pinned ? "Unpin" : "Pin"}
        >
          {pinned ? "★" : "☆"}
        </button>
      )}

      {/* Tooltip when collapsed */}
      {collapsed && (
        <div className="pointer-events-none absolute left-full ml-2 hidden rounded bg-gray-900 px-2 py-1 text-xs text-white group-hover:block z-50">
          {item.label}
          {item.external && " ↗"}
        </div>
      )}
    </div>
  );
}
