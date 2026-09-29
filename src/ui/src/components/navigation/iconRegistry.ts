/**
 * Quest 05 Part 8c — Lucide icon registry.
 * Maps string names from navConfig to Lucide components.
 * Single source of truth for icon imports.
 */

import * as LucideIcons from "lucide-react";
import type { LucideIcon } from "lucide-react";

/** All icon names used across the UI */
const ICON_NAMES = [
  // Navigation icons
  "LayoutDashboard",
  "Inbox",
  "GitPullRequestArrow",
  "ScanLine",
  "FilePen",
  "Radar",
  "ShieldAlert",
  "UserCheck",
  "ShieldCheck",
  "UserPlus",
  "Target",
  "Users",
  "Lightbulb",
  "ListChecks",
  "UserMinus",
  "BarChart3",
  "FileText",
  "Search",
  "Brain",
  "MessageSquareWarning",
  "ScrollText",
  "Settings",
  "ExternalLink",
  // UI control icons
  "Star",
  "ChevronsLeft",
  "ChevronsRight",
  "ChevronDown",
  "ChevronUp",
  "X",
  "Menu",
  "Pin",
  "Clock",
  "Command",
  "Download",
  "Check",
  // Settings tab icons
  "User",
  "Building2",
  "Key",
  "Link",
  "Plug",
  "VenetianMask",
  "CircleCheck",
  "HardDrive",
  "ClipboardList",
  "Package",
  // Component icons
  "File",
  "Paperclip",
  "Mailbox",
  "Mail",
  "Briefcase",
  "Phone",
  "AlertTriangle",
  "Play",
  "Circle",
  "Copy",
] as const;

export type IconName = (typeof ICON_NAMES)[number];

/** Registry: name → LucideIcon component */
export const ICON_REGISTRY: Record<string, LucideIcon> = {};

for (const name of ICON_NAMES) {
  const component = (LucideIcons as Record<string, unknown>)[name];
  // Lucide icons are forwardRef objects (typeof "object"), not plain functions
  if (component && (typeof component === "function" || typeof component === "object")) {
    ICON_REGISTRY[name] = component as LucideIcon;
  }
}

/** Get a Lucide icon component by name, fallback to Circle */
export function getIcon(name: string): LucideIcon {
  return ICON_REGISTRY[name] ?? (LucideIcons.Circle as LucideIcon);
}
