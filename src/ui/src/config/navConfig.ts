/**
 * Quest 05 Part 8b — Navigation configuration.
 * Defines the sidebar structure with grouped sections.
 * Every tab in App.tsx must appear here for CI guard compliance.
 */

export type NavItemId =
  | "recruitment"
  | "intake"
  | "gates"
  | "mcq"
  | "exams"
  | "dimensions"
  | "fraud"
  | "references"
  | "verification"
  | "onboarding"
  | "kpi"
  | "personas"
  | "improvements"
  | "tasks"
  | "offboarding"
  | "analytics"
  | "reports"
  | "rediscovery"
  | "brain"
  | "appeals"
  | "audit"
  | "settings"
  | "skills_portal";

export interface NavItem {
  id: NavItemId;
  label: string;
  icon: string;
  /** External link opens in new tab */
  external?: boolean;
  /** RBAC roles that can see this item */
  allowedRoles?: string[];
  /** Badge count (e.g., pending gates) */
  badge?: number;
}

export interface NavGroup {
  id: string;
  label: string;
  icon: string;
  items: NavItem[];
  /** RBAC roles that can see this group */
  allowedRoles?: string[];
}

export const NAV_CONFIG: NavGroup[] = [
  {
    id: "recruitment",
    label: "RECRUITMENT",
    icon: "📋",
    items: [
      { id: "recruitment", label: "Dashboard", icon: "🏠" },
      { id: "intake", label: "Intake", icon: "📥" },
      { id: "gates", label: "HIL Gates", icon: "🚧" },
    ],
  },
  {
    id: "assessment",
    label: "ASSESSMENT",
    icon: "📝",
    items: [
      { id: "mcq", label: "MCQ Scanner", icon: "📄" },
      { id: "exams", label: "Digital Exam Creator", icon: "💻" },
      { id: "dimensions", label: "7-Dimension Matching", icon: "🎯" },
    ],
  },
  {
    id: "quality",
    label: "QUALITY & VERIFICATION",
    icon: "✓",
    items: [
      { id: "fraud", label: "Fraud Detection", icon: "🔍" },
      { id: "references", label: "Reference Checks", icon: "📞" },
      { id: "verification", label: "Verification Center", icon: "✅" },
    ],
  },
  {
    id: "people",
    label: "PEOPLE",
    icon: "👥",
    items: [
      { id: "onboarding", label: "Onboarding", icon: "🎉" },
      { id: "kpi", label: "KPI", icon: "📊" },
      { id: "personas", label: "Personas", icon: "🎭" },
      { id: "improvements", label: "Improvement Advisor", icon: "💡" },
      { id: "tasks", label: "Task Logs", icon: "📋" },
      { id: "offboarding", label: "Offboarding", icon: "👋" },
    ],
  },
  {
    id: "analytics_group",
    label: "ANALYTICS",
    icon: "📈",
    items: [
      { id: "analytics", label: "Recruitment Analytics", icon: "📊" },
      { id: "reports", label: "Reports", icon: "📑" },
      { id: "rediscovery", label: "Candidate Rediscovery", icon: "🔎" },
    ],
  },
  {
    id: "admin",
    label: "ADMIN",
    icon: "⚙️",
    allowedRoles: ["ADMIN", "AUDITOR"],
    items: [
      { id: "brain", label: "Brain Studio", icon: "🧠" },
      { id: "appeals", label: "Appeals", icon: "⚖️" },
      { id: "audit", label: "Audit", icon: "📜" },
      { id: "settings", label: "Settings", icon: "⚙️" },
      { id: "skills_portal", label: "Skills Portal", icon: "🎓", external: true },
    ],
  },
];

/** Flatten all nav items for search/lookup */
export function getAllNavItems(): NavItem[] {
  return NAV_CONFIG.flatMap((g) => g.items);
}

/** Find a nav item by ID */
export function findNavItem(id: NavItemId): NavItem | undefined {
  return getAllNavItems().find((item) => item.id === id);
}

/** Find the group containing an item */
export function findNavGroup(itemId: NavItemId): NavGroup | undefined {
  return NAV_CONFIG.find((g) => g.items.some((item) => item.id === itemId));
}

/** Filter nav config by user role */
export function filterNavByRole(role: string): NavGroup[] {
  return NAV_CONFIG.map((group) => {
    // Filter group-level roles
    if (group.allowedRoles && !group.allowedRoles.includes(role)) {
      return null;
    }
    // Filter item-level roles
    const filteredItems = group.items.filter(
      (item) => !item.allowedRoles || item.allowedRoles.includes(role)
    );
    if (filteredItems.length === 0) return null;
    return { ...group, items: filteredItems };
  }).filter((g): g is NavGroup => g !== null);
}
