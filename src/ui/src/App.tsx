import { useState } from "react";
import { CommandBar } from "./components/CommandBar";
import { PipelineStrip } from "./components/PipelineStrip";
import { DecisionQueue } from "./components/DecisionQueue";
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
import { I18nProvider } from "./i18n";

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
] as const;

type TabKey = (typeof TABS)[number]["key"];

export function App() {
  const [tab, setTab] = useState<TabKey>("recruitment");

  return (
    <I18nProvider>
      <div className="flex h-screen flex-col bg-background">
      <CommandBar />

      <div className="flex items-center gap-1 border-b border-border-soft bg-surface px-6 py-2">
        {TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`rounded-md px-3 py-1.5 text-xs font-medium ${
              tab === t.key ? "bg-agent text-white" : "text-text-secondary hover:bg-background"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="flex flex-1 gap-4 overflow-hidden p-4">
        <div className="flex flex-1 flex-col gap-4 overflow-auto">
          {tab === "recruitment" && (
            <>
              <PipelineStrip />
              <div className="flex-1 overflow-hidden">
                <DecisionQueue />
              </div>
            </>
          )}
          {tab === "appeals" && <PanelCard title="Appeals"><AppealsPanel /></PanelCard>}
          {tab === "tasks" && <PanelCard title="Task Logs"><TaskLogsPanel /></PanelCard>}
          {tab === "onboarding" && <PanelCard title="Onboarding"><OnboardingPanel /></PanelCard>}
          {tab === "kpi" && <PanelCard title="KPI Scores"><KpiPanel /></PanelCard>}
          {tab === "personas" && <PanelCard title="Departmental Personas"><PersonasPanel /></PanelCard>}
          {tab === "improvements" && <PanelCard title="Improvement Advisor"><ImprovementsPanel /></PanelCard>}
          {tab === "dimensions" && <PanelCard title="7-Dimension Candidate Matching"><DimensionScorecard /></PanelCard>}
          {tab === "mcq" && <PanelCard title="Paper-Based MCQ Scanner"><McqScannerPanel /></PanelCard>}
          {tab === "exams" && <PanelCard title="Digital Exam Paper Creator"><DigitalExamBuilder /></PanelCard>}
          {tab === "fraud" && <PanelCard title="Fraud & Inconsistency Detection"><FraudDetectionPanel /></PanelCard>}
          {tab === "references" && <PanelCard title="Automated Reference Checking"><ReferenceCheckPanel /></PanelCard>}
          {tab === "analytics" && <PanelCard title="Recruitment Analytics & Source Effectiveness"><RecruitmentAnalyticsPanel /></PanelCard>}
          {tab === "offboarding" && <PanelCard title="Offboarding & Exit Management"><OffboardingPanel /></PanelCard>}
          {tab === "rediscovery" && <PanelCard title="Candidate Rediscovery / Talent Pool Re-engagement"><RediscoveryPanel /></PanelCard>}
          {tab === "gates" && <PanelCard title="Human-in-the-Loop Gate Inbox"><HilGateInbox /></PanelCard>}
        </div>

        {/* Audit & reports sidebar: what the platform did, and whether any
            agent was shedding or retrying work while it did it. */}
        <div className="flex w-80 flex-shrink-0 flex-col gap-4 overflow-hidden">
          <AgentHealth />
          <div className="min-h-0 flex-1">
            <AuditStream />
          </div>
        </div>
      </div>
      </div>
    </I18nProvider>
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
