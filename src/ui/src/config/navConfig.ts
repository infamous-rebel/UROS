/**
 * Quest 05 Part 8b/8c — Navigation configuration.
 * Defines the sidebar structure with grouped sections.
 * Every tab in App.tsx must appear here for CI guard compliance.
 * Icons are Lucide component names (resolved in NavItem.tsx).
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
  icon: string; // Lucide component name
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
  icon: string; // Lucide component name
  items: NavItem[];
  /** RBAC roles that can see this group */
  allowedRoles?: string[];
}

export const NAV_CONFIG: NavGroup[] = [
  {
    id: "recruitment",
    label: "RECRUITMENT",
    icon: "LayoutDashboard",
    items: [
      { id: "recruitment", label: "Dashboard", icon: "LayoutDashboard" },
      { id: "intake", label: "Intake", icon: "Inbox" },
      { id: "gates", label: "HIL Gates", icon: "GitPullRequestArrow" },
    ],
  },
  {
    id: "assessment",
    label: "ASSESSMENT",
    icon: "FileText",
    items: [
      { id: "mcq", label: "MCQ Scanner", icon: "ScanLine" },
      { id: "exams", label: "Digital Exam Creator", icon: "FilePen" },
      { id: "dimensions", label: "7-Dimension Matching", icon: "Radar" },
    ],
  },
  {
    id: "quality",
    label: "QUALITY & VERIFICATION",
    icon: "ShieldCheck",
    items: [
      { id: "fraud", label: "Fraud Detection", icon: "ShieldAlert" },
      { id: "references", label: "Reference Checks", icon: "UserCheck" },
      { id: "verification", label: "Verification Center", icon: "ShieldCheck" },
    ],
  },
  {
    id: "people",
    label: "PEOPLE",
    icon: "Users",
    items: [
      { id: "onboarding", label: "Onboarding", icon: "UserPlus" },
      { id: "kpi", label: "KPI", icon: "Target" },
      { id: "personas", label: "Personas", icon: "Users" },
      { id: "improvements", label: "Improvement Advisor", icon: "Lightbulb" },
      { id: "tasks", label: "Task Logs", icon: "ListChecks" },
      { id: "offboarding", label: "Offboarding", icon: "UserMinus" },
    ],
  },
  {
    id: "analytics_group",
    label: "ANALYTICS",
    icon: "BarChart3",
    items: [
      { id: "analytics", label: "Recruitment Analytics", icon: "BarChart3" },
      { id: "reports", label: "Reports", icon: "FileText" },
      { id: "rediscovery", label: "Candidate Rediscovery", icon: "Search" },
    ],
  },
  {
    id: "admin",
    label: "ADMIN",
    icon: "Settings",
    allowedRoles: ["ADMIN", "AUDITOR"],
    items: [
      { id: "brain", label: "Brain Studio", icon: "Brain" },
      { id: "appeals", label: "Appeals", icon: "MessageSquareWarning" },
      { id: "audit", label: "Audit", icon: "ScrollText" },
      { id: "settings", label: "Settings", icon: "Settings" },
      { id: "skills_portal", label: "Skills Portal", icon: "ExternalLink", external: true },
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
    if (group.allowedRoles && !group.allowedRoles.includes(role)) {
      return null;
    }
    const filteredItems = group.items.filter(
      (item) => !item.allowedRoles || item.allowedRoles.includes(role)
    );
    if (filteredItems.length === 0) return null;
    return { ...group, items: filteredItems };
  }).filter((g): g is NavGroup => g !== null);
}
