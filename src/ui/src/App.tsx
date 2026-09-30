import { useEffect, useState, useCallback } from "react";
import { CommandBar } from "./components/CommandBar";
import { PipelineStrip } from "./components/PipelineStrip";
import { DecisionQueue } from "./components/DecisionQueue";
import { CandidateList } from "./components/CandidateList";
import { CandidateInspector } from "./components/CandidateInspector";
import { AuditStream } from "./components/AuditStream";
import { AgentHealth } from "./components/AgentHealth";
import { AppealsPanel } from "./components/AppealsPanel";
import { TaskLogsPanel } from "./components/TaskLogsPanel";
import { OnboardingPanel } from "./components/OnboardingPanel";
import { KpiPanel } from "./components/KpiPanel";
import { PersonasPanel } from "./components/PersonasPanel";
import { ImprovementsPanel } from "./components/ImprovementsPanel";
import { DimensionScorecard } from "./components/DimensionScorecard";
import { McqScannerPanel } from "./components/McqScannerPanel";
import { DigitalExamBuilder } from "./components/DigitalExamBuilder";
import { FraudDetectionPanel } from "./components/FraudDetectionPanel";
import { ReferenceCheckPanel } from "./components/ReferenceCheckPanel";
import { RecruitmentAnalyticsPanel } from "./components/RecruitmentAnalyticsPanel";
import { OffboardingPanel } from "./components/OffboardingPanel";
import { RediscoveryPanel } from "./components/RediscoveryPanel";
import { HilGateInbox } from "./components/HilGateInbox";
import { CandidateIntakePanel } from "./components/CandidateIntakePanel";
import { EmailIntakePanel } from "./components/EmailIntakePanel";
import { BdjobsPanel } from "./components/BdjobsPanel";
import { TeletalkPanel } from "./components/TeletalkPanel";
import { BrainStudio } from "./components/BrainStudio";
import { Settings } from "./components/Settings";
import { ReportsTab } from "./components/ReportsTab";
import { VerificationCenter } from "./components/VerificationCenter";
import { LoginScreen } from "./components/auth/LoginScreen";
import { ForgotPasswordScreen } from "./components/auth/ForgotPasswordScreen";
import { ResetPasswordScreen } from "./components/auth/ResetPasswordScreen";
import { ChangePasswordScreen } from "./components/auth/ChangePasswordScreen";
import { SessionManager } from "./components/auth/SessionManager";
import { AuthProvider, useAuth } from "./auth/AuthContext";
import { I18nProvider, useI18n } from "./i18n";
import { ToastProvider } from "./components/Toast";
import { ThemeProvider } from "./theme/ThemeContext";
import { Sidebar } from "./components/navigation/Sidebar";
import { Breadcrumb } from "./components/navigation/Breadcrumb";
import { CommandPalette } from "./components/navigation/CommandPalette";
import { useNavState } from "./components/navigation/useNavState";
import type { NavItemId } from "./config/navConfig";

// Legacy tab keys for backward compatibility
const TABS = [
  { key: "recruitment", label: "Recruitment" },
  { key: "appeals", label: "Appeals" },
  { key: "tasks", label: "Task Logs" },
  { key: "onboarding", label: "Onboarding" },
  { key: "kpi", label: "KPI" },
  { key: "personas", label: "Personas" },
  { key: "improvements", label: "Improvement Advisor" },
  { key: "dimensions", label: "7-Dimension Matching" },
  { key: "mcq", label: "MCQ Scanner" },
  { key: "exams", label: "Digital Exam Creator" },
  { key: "fraud", label: "Fraud Detection" },
  { key: "references", label: "Reference Checks" },
  { key: "analytics", label: "Recruitment Analytics" },
  { key: "offboarding", label: "Offboarding" },
  { key: "rediscovery", label: "Candidate Rediscovery" },
  { key: "gates", label: "HIL Gates" },
  { key: "intake", label: "Intake" },
  { key: "brain", label: "Brain Studio" },
  { key: "reports", label: "Reports" },
  { key: "settings", label: "Settings" },
  { key: "verification", label: "Verification Center" },
] as const;

type TabKey = (typeof TABS)[number]["key"];

/**
 * Quest 05 Part 1c — route guard. The auth provider decides between the
 * sign-in surface and the dashboard; password-reset links land on
 * /reset-password?token=… and in-app views ride the URL hash. No router
 * library, consistent with the rest of this shell.
 */
export function App() {
  return (
    <ThemeProvider>
      <I18nProvider>
        <AuthProvider>
          <ToastProvider>
            <AppBody />
          </ToastProvider>
        </AuthProvider>
      </I18nProvider>
    </ThemeProvider>
  );
}

/** Current hash as state, so view swaps re-render without a router. */
function useHashView(): string {
  const [hash, setHash] = useState(window.location.hash);
  useEffect(() => {
    const onChange = () => setHash(window.location.hash);
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  return hash;
}

function AppBody() {
  const { status } = useAuth();
  const { t } = useI18n();
  const hash = useHashView();

  if (status === "loading") {
    return <AuthShell>{<p className="text-sm text-text-secondary">{t("auth.checkingSession")}</p>}</AuthShell>;
  }

  if (status === "unauthenticated") {
    // One-time reset links land on /reset-password?token=… at the UI origin.
    if (window.location.pathname === "/reset-password") {
      return <AuthShell><ResetPasswordScreen /></AuthShell>;
    }
    if (hash === "#/forgot") {
      return <AuthShell><ForgotPasswordScreen /></AuthShell>;
    }
    return <AuthShell><LoginScreen /></AuthShell>;
  }

  // Authenticated in-app views (CommandBar links); back = clear the hash.
  // Quest 05 Part 4 — #/candidates route opens the full candidate list.
  if (hash.startsWith("#/candidates")) {
    return <CandidateListView />;
  }
  if (hash === "#/sessions") {
    return (
      <DashboardOverlay title={t("auth.sessionsTitle")}>
        <SessionManager />
      </DashboardOverlay>
    );
  }
  if (hash === "#/password") {
    return (
      <DashboardOverlay title={t("auth.changePasswordTitle")}>
        <ChangePasswordScreen />
      </DashboardOverlay>
    );
  }

  return <Dashboard />;
}

function AuthShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-screen flex-col items-center justify-center gap-4 bg-background p-4">
      <div className="text-center">
        <div className="text-xl font-semibold text-text-primary">UROS</div>
        <div className="text-xs text-text-secondary">Unified Recruitment Operating System</div>
      </div>
      {children}
    </div>
  );
}

function DashboardOverlay({ title, children }: { title: string; children: React.ReactNode }) {
  const { t } = useI18n();
  return (
    <div className="flex h-screen flex-col bg-background">
      <CommandBar />
      <div className="flex-1 overflow-auto p-6">
        <button
          onClick={() => {
            window.location.hash = "";
          }}
          className="mb-3 text-xs text-text-secondary hover:text-text-primary"
        >
          ← {t("auth.backToDashboard")}
        </button>
        <h2 className="mb-3 text-sm font-semibold text-text-primary">{title}</h2>
        {children}
      </div>
    </div>
  );
}

/** Quest 05 Part 8b — Dashboard with sidebar navigation. */
function Dashboard() {
  const navState = useNavState();
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [cmdPaletteOpen, setCmdPaletteOpen] = useState(false);
  const [hilGateBadge, setHilGateBadge] = useState(0);

  // Cmd+K keyboard shortcut
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setCmdPaletteOpen((prev) => !prev);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  // Fetch pending HIL gates count for badge
  useEffect(() => {
    const fetchBadge = async () => {
      try {
        const { authedRequest } = await import("./api/client");
        const res = await authedRequest<{ gates: unknown[] }>("/gates?status=pending&limit=100");
        setHilGateBadge(res.gates?.length ?? 0);
      } catch {
        // Ignore errors
      }
    };
    fetchBadge();
    const interval = setInterval(fetchBadge, 30000); // Poll every 30s
    return () => clearInterval(interval);
  }, []);

  const handleNavigate = useCallback((id: NavItemId) => {
    navState.setActiveItem(id);
  }, [navState]);

  // Map nav item to tab key (they're the same for most items)
  const activeTab = navState.activeItem as TabKey;

  return (
    <div className="flex h-screen bg-background">
      {/* Sidebar */}
      <Sidebar
        activeItem={navState.activeItem}
        collapsed={navState.collapsed}
        pinned={navState.pinned}
        onItemClick={handleNavigate}
        onPin={navState.togglePinned}
        onToggleCollapse={navState.toggleCollapsed}
        mobileOpen={mobileMenuOpen}
        onMobileClose={() => setMobileMenuOpen(false)}
        badgeOverrides={{ gates: hilGateBadge }}
      />

      {/* Main content area */}
      <div className="flex flex-1 flex-col overflow-hidden">
        {/* CommandBar */}
        <CommandBar />

        {/* Mobile hamburger + Breadcrumb */}
        <div className="flex items-center gap-3 border-b border-border-soft bg-surface px-4 py-2 lg:px-6">
          {/* Mobile hamburger */}
          <button
            onClick={() => setMobileMenuOpen(true)}
            className="rounded p-1 text-text-secondary hover:bg-background hover:text-text-primary lg:hidden"
            aria-label="Open menu"
          >
            <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
            </svg>
          </button>

          {/* Breadcrumb */}
          <Breadcrumb activeItem={navState.activeItem} onItemClick={handleNavigate} />
        </div>

        {/* Main panel with content */}
        <div className="flex flex-1 gap-4 overflow-hidden p-4">
          <div className="flex flex-1 flex-col gap-4 overflow-auto">
            {activeTab === "recruitment" && (
              <>
                <PipelineStrip />
                <div className="flex-1 overflow-hidden">
                  <DecisionQueue />
                </div>
              </>
            )}
            {activeTab === "appeals" && <PanelCard title="Appeals"><AppealsPanel /></PanelCard>}
            {activeTab === "tasks" && <PanelCard title="Task Logs"><TaskLogsPanel /></PanelCard>}
            {activeTab === "onboarding" && <PanelCard title="Onboarding"><OnboardingPanel /></PanelCard>}
            {activeTab === "kpi" && <PanelCard title="KPI Scores"><KpiPanel /></PanelCard>}
            {activeTab === "personas" && <PanelCard title="Departmental Personas"><PersonasPanel /></PanelCard>}
            {activeTab === "improvements" && <PanelCard title="Improvement Advisor"><ImprovementsPanel /></PanelCard>}
            {activeTab === "dimensions" && <PanelCard title="7-Dimension Candidate Matching"><DimensionScorecard /></PanelCard>}
            {activeTab === "mcq" && <PanelCard title="Paper-Based MCQ Scanner"><McqScannerPanel /></PanelCard>}
            {activeTab === "exams" && <PanelCard title="Digital Exam Paper Creator"><DigitalExamBuilder /></PanelCard>}
            {activeTab === "fraud" && <PanelCard title="Fraud & Inconsistency Detection"><FraudDetectionPanel /></PanelCard>}
            {activeTab === "references" && <PanelCard title="Automated Reference Checking"><ReferenceCheckPanel /></PanelCard>}
            {activeTab === "analytics" && <PanelCard title="Recruitment Analytics & Source Effectiveness"><RecruitmentAnalyticsPanel /></PanelCard>}
            {activeTab === "offboarding" && <PanelCard title="Offboarding & Exit Management"><OffboardingPanel /></PanelCard>}
            {activeTab === "rediscovery" && <PanelCard title="Candidate Rediscovery / Talent Pool Re-engagement"><RediscoveryPanel /></PanelCard>}
            {activeTab === "gates" && (
              <PanelCard title="Human-in-the-Loop Gate Inbox">
                <HilGateInbox />
              </PanelCard>
            )}
            {activeTab === "intake" && <IntakeSection />}
            {activeTab === "brain" && <PanelCard title="Brain Studio — Rule Pack Editor"><BrainStudio /></PanelCard>}
            {activeTab === "reports" && <PanelCard title="Reports"><ReportsTab /></PanelCard>}
            {activeTab === "settings" && <PanelCard title="Settings"><Settings /></PanelCard>}
            {activeTab === "verification" && <PanelCard title="Verification Center"><VerificationCenter /></PanelCard>}
          </div>

          {/* Audit & reports sidebar: what the platform did, and whether any
              agent was shedding or retrying work while it did it. */}
          <div className="hidden w-80 flex-shrink-0 flex-col gap-4 overflow-hidden xl:flex">
            <AgentHealth />
            <div className="min-h-0 flex-1">
              <AuditStream />
            </div>
          </div>
        </div>
      </div>

      {/* Command Palette (Cmd+K) */}
      <CommandPalette
        open={cmdPaletteOpen}
        onClose={() => setCmdPaletteOpen(false)}
        onNavigate={handleNavigate}
      />
    </div>
  );
}

function PanelCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-border-soft bg-surface p-4">
      <h2 className="mb-3 text-sm font-semibold text-text-primary">{title}</h2>
      {children}
    </div>
  );
}

/** Quest 05 Part 5 — Intake section with sub-tabs for each source. */
function IntakeSection() {
  const [subTab, setSubTab] = useState<"candidates" | "email" | "bdjobs" | "teletalk">("candidates");
  const subTabs = [
    { key: "candidates" as const, label: "CV / CSV" },
    { key: "email" as const, label: "Email" },
    { key: "bdjobs" as const, label: "Bdjobs" },
    { key: "teletalk" as const, label: "Teletalk" },
  ];
  return (
    <div className="rounded-lg border border-border-soft bg-surface p-4">
      <h2 className="mb-3 text-sm font-semibold text-text-primary">Candidate Intake</h2>
      <div className="mb-3 flex gap-1">
        {subTabs.map((t) => (
          <button
            key={t.key}
            onClick={() => setSubTab(t.key)}
            className={`rounded px-3 py-1.5 text-xs font-medium ${
              subTab === t.key ? "bg-agent text-white" : "text-text-secondary hover:bg-background"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>
      {subTab === "candidates" && <CandidateIntakePanel />}
      {subTab === "email" && <EmailIntakePanel />}
      {subTab === "bdjobs" && <BdjobsPanel />}
      {subTab === "teletalk" && <TeletalkPanel />}
    </div>
  );
}

/** Quest 05 Part 4 — Candidate list + inspector side panel. */
function CandidateListView() {
  // Parse hash for inspect param: #/candidates?inspect=<id>
  const hashParams = window.location.hash.includes("?")
    ? new URLSearchParams(window.location.hash.split("?")[1])
    : null;
  const initialInspect = hashParams?.get("inspect") ?? null;
  const [inspecting, setInspecting] = useState<string | null>(initialInspect);

  return (
    <div className="flex h-screen flex-col bg-background">
      <CommandBar />
      <div className="flex-1 overflow-hidden p-4">
        <button
          onClick={() => { window.location.hash = ""; }}
          className="mb-3 text-xs text-text-secondary hover:text-text-primary"
        >
          ← Back to Dashboard
        </button>
        <div className="flex h-[calc(100%-2rem)] gap-4">
          <div className={`flex-1 overflow-hidden ${inspecting ? "mr-0" : ""}`}>
            <CandidateList onInspect={(id) => setInspecting(id)} />
          </div>
          {inspecting && (
            <div className="w-96 flex-shrink-0 overflow-hidden">
              <CandidateInspector candidateId={inspecting} onClose={() => setInspecting(null)} />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
