import { useState } from "react";
import {
  useAnalyticsConfig,
  useConfigureAnalytics,
  useAddSourceCost,
  useSourceEffectiveness,
  useFunnelAnalysis,
  useQualityHireCost,
  SOURCE_PLATFORMS,
  SourcePlatform,
  UnderperformanceFlag,
  FunnelStage,
  SourceEffectivenessMetrics,
  QualityHireSourceCost,
} from "../hooks/hooks_analytics";
import { getToken, API_V1 } from "../api/client";
import { useI18n } from "../i18n";
import { EmptyState } from "./EmptyState";
import { DownloadButton } from "./DownloadButton";
import { ReasonCode } from "./ReasonCode";

const FUNNEL_STAGE_LABEL_KEY: Record<FunnelStage["stage"], string> = {
  APPLIED: "analytics.applied",
  ELIGIBLE: "analytics.eligible",
  SCORED: "analytics.scored",
  SHORTLISTED: "analytics.shortlisted",
  COMMUNICATED: "analytics.communicated",
  SELECTED: "analytics.selected",
};

function pct(n: number, digits = 1): string {
  return `${(n * 100).toFixed(digits)}%`;
}

function FlagsList({ flags }: { flags: UnderperformanceFlag[] }) {
  const { t } = useI18n();
  if (flags.length === 0) {
    return <div className="text-xs text-success">{t("analytics.noFlags")}</div>;
  }
  return (
    <div className="flex flex-col gap-2">
      {flags.map((f, i) => (
        <div key={`${f.source_platform}-${f.reason_code}-${i}`} className="rounded-md border border-attention bg-surface p-2">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-text-primary">{f.source_platform}</span>
            <span className="rounded bg-attention px-1.5 py-0.5 text-[10px] font-medium text-white"><ReasonCode code={f.reason_code} size="sm" /></span>
          </div>
          <div className="mt-1 text-xs text-text-primary">{f.reason_description}</div>
          <details className="mt-1">
            <summary className="cursor-pointer text-[11px] text-agent underline">Why? (evidence)</summary>
            <pre className="mt-1 max-h-40 overflow-auto rounded bg-background p-2 text-[11px] text-text-secondary">
              {JSON.stringify(f.evidence, null, 2)}
            </pre>
          </details>
        </div>
      ))}
    </div>
  );
}

function SourceComparisonTable({ sources }: { sources: SourceEffectivenessMetrics[] }) {
  const { t } = useI18n();
  if (sources.length === 0) {
    return <EmptyState message={t("analytics.noSourceData")} />;
  }
  return (
    <div className="overflow-hidden rounded-lg border border-border-soft bg-surface">
      <table className="w-full text-left text-xs">
        <thead className="bg-background">
          <tr className="text-text-secondary">
            <th className="px-3 py-2">{t("analytics.source")}</th>
            <th className="px-3 py-2">{t("analytics.candidates")}</th>
            <th className="px-3 py-2">{t("analytics.passRate")}</th>
            <th className="px-3 py-2">{t("analytics.interviewRate")}</th>
            <th className="px-3 py-2">{t("analytics.selectionRate")}</th>
          </tr>
        </thead>
        <tbody>
          {sources.map((s) => (
            <tr key={s.source_platform} className="border-t border-border-soft">
              <td className="px-3 py-2 font-medium text-text-primary">{s.source_platform}</td>
              <td className="px-3 py-2 text-text-secondary">{s.total_candidates}</td>
              <td className="px-3 py-2 text-text-primary">{pct(s.pass_rate)}</td>
              <td className="px-3 py-2 text-text-primary">{pct(s.interview_rate)}</td>
              <td className="px-3 py-2 text-text-primary">{pct(s.selection_rate, 2)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function FunnelView({ stages }: { stages: FunnelStage[] }) {
  const { t } = useI18n();
  const max = Math.max(1, ...stages.map((s) => s.count));
  return (
    <div className="flex flex-col gap-2">
      {stages.map((s) => (
        <div key={s.stage} className="flex items-center gap-3">
          <div className="w-28 flex-shrink-0 text-xs text-text-secondary">{t(FUNNEL_STAGE_LABEL_KEY[s.stage] as any)}</div>
          <div className="h-4 flex-1 overflow-hidden rounded bg-background">
            <div className="h-4 rounded bg-agent" style={{ width: `${Math.max(2, (s.count / max) * 100)}%` }} />
          </div>
          <div className="w-12 flex-shrink-0 text-right text-xs font-medium text-text-primary">{s.count}</div>
        </div>
      ))}
    </div>
  );
}

function QualityHireTable({ sources }: { sources: QualityHireSourceCost[] }) {
  const { t } = useI18n();
  if (sources.length === 0) {
    return <EmptyState message={t("analytics.noCostData")} />;
  }
  return (
    <div className="overflow-hidden rounded-lg border border-border-soft bg-surface">
      <table className="w-full text-left text-xs">
        <thead className="bg-background">
          <tr className="text-text-secondary">
            <th className="px-3 py-2">{t("analytics.source")}</th>
            <th className="px-3 py-2">{t("analytics.totalCost")}</th>
            <th className="px-3 py-2">{t("analytics.qualityHires")}</th>
            <th className="px-3 py-2">{t("analytics.costPerHire")}</th>
          </tr>
        </thead>
        <tbody>
          {sources.map((s) => (
            <tr key={s.source_platform} className="border-t border-border-soft">
              <td className="px-3 py-2 font-medium text-text-primary">{s.source_platform}</td>
              <td className="px-3 py-2 text-text-secondary">{s.total_cost.toLocaleString()}</td>
              <td className="px-3 py-2 text-text-primary">{s.quality_hire_count}</td>
              <td className="px-3 py-2 text-text-primary">
                {s.cost_per_quality_hire === null ? <span className="text-text-secondary">—</span> : s.cost_per_quality_hire.toFixed(2)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ExportButtons({
  report,
  circularId,
  timeWindowDays,
}: {
  report: "sources" | "funnel" | "quality-hire";
  circularId?: string;
  timeWindowDays?: number;
}) {
  const qs = (fmt: string) => {
    const p = new URLSearchParams({ report, format: fmt });
    if (circularId) p.set("circular_id", circularId);
    if (timeWindowDays) p.set("time_window_days", String(timeWindowDays));
    return `${API_V1}/analytics/export?${p}`;
  };

  return (
    <div className="flex items-center gap-2">
      <DownloadButton endpoint={qs("csv")} format="csv" filename={`${report}.csv`} label="CSV" size="sm" />
      <DownloadButton endpoint={qs("excel")} format="xlsx" filename={`${report}.xlsx`} label="Excel" size="sm" />
      <DownloadButton endpoint={qs("pdf")} format="pdf" filename={`${report}.pdf`} label="PDF" size="sm" />
    </div>
  );
}

function ConfigureAnalytics() {
  const { t } = useI18n();
  const { data, isLoading, isError } = useAnalyticsConfig();
  const configure = useConfigureAnalytics();
  const [minPassRate, setMinPassRate] = useState("");
  const [minSelectionRate, setMinSelectionRate] = useState("");
  const [maxCostPerHire, setMaxCostPerHire] = useState("");
  const [minScore, setMinScore] = useState("");
  const [windowDays, setWindowDays] = useState("90");

  if (isLoading) return <EmptyState message={t("analytics.loadingConfig")} />;
  if (isError) return <EmptyState message={t("analytics.apiError")} tone="danger" />;

  const effective = data?.effective_quality_hire_definition;
  const effectiveWindow = data?.effective_default_time_window_days ?? 90;

  const submit = () => {
    configure.mutate({
      quality_hire_definition: {
        hire_statuses: ["SELECTED"],
        min_score: minScore.trim() ? Number(minScore) : null,
        thresholds: {
          ...(minPassRate.trim() ? { min_pass_rate: Number(minPassRate) } : {}),
          ...(minSelectionRate.trim() ? { min_selection_rate: Number(minSelectionRate) } : {}),
          ...(maxCostPerHire.trim() ? { max_cost_per_quality_hire: Number(maxCostPerHire) } : {}),
        },
      },
      default_time_window_days: Number(windowDays) || 90,
    });
  };

  return (
    <div className="rounded-lg border border-border-soft bg-surface p-3">
      <div className="mb-2 text-xs font-semibold text-text-primary">{t("analytics.qualityDefinition")}</div>
      <div className="mb-2 text-[11px] text-text-secondary">
        {data?.is_system_default ? "Using system defaults" : "Org-configured"} — hire statuses: {effective?.hire_statuses.join(", ")}
        {effective?.min_score !== null && effective?.min_score !== undefined ? `, min score ${effective.min_score}` : ""}, window{" "}
        {effectiveWindow} day(s).
      </div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
        <input
          value={minPassRate}
          onChange={(e) => setMinPassRate(e.target.value)}
          placeholder={t("analytics.minPassPlaceholder")}
          className="rounded-md border border-border-soft bg-background px-2 py-1.5 text-xs"
        />
        <input
          value={minSelectionRate}
          onChange={(e) => setMinSelectionRate(e.target.value)}
          placeholder={t("analytics.minSelectionPlaceholder")}
          className="rounded-md border border-border-soft bg-background px-2 py-1.5 text-xs"
        />
        <input
          value={maxCostPerHire}
          onChange={(e) => setMaxCostPerHire(e.target.value)}
          placeholder={t("analytics.maxCostPlaceholder")}
          className="rounded-md border border-border-soft bg-background px-2 py-1.5 text-xs"
        />
        <input
          value={minScore}
          onChange={(e) => setMinScore(e.target.value)}
          placeholder={t("analytics.minScorePlaceholder")}
          className="rounded-md border border-border-soft bg-background px-2 py-1.5 text-xs"
        />
        <input
          value={windowDays}
          onChange={(e) => setWindowDays(e.target.value)}
          placeholder={t("analytics.windowPlaceholder")}
          className="rounded-md border border-border-soft bg-background px-2 py-1.5 text-xs"
        />
      </div>
      <div className="mt-2 flex items-center gap-2">
        <button
          disabled={configure.isPending}
          onClick={submit}
          className="rounded-md bg-agent px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50"
        >
          {configure.isPending ? t("analytics.saving") : t("analytics.saveConfig")}
        </button>
        {configure.isError && <span className="text-xs text-danger">{(configure.error as Error)?.message ?? t("analytics.saveFailed")}</span>}
      </div>
    </div>
  );
}

function AddSourceCost() {
  const { t } = useI18n();
  const addCost = useAddSourceCost();
  const [source, setSource] = useState<SourcePlatform>("bdjobs");
  const [campaignId, setCampaignId] = useState("");
  const [cost, setCost] = useState("");
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));

  const submit = () => {
    const numericCost = Number(cost);
    if (!cost.trim() || Number.isNaN(numericCost) || numericCost < 0) return;
    addCost.mutate({ source_platform: source, campaign_id: campaignId.trim() || undefined, cost: numericCost, effective_date: date });
  };

  return (
    <div className="rounded-lg border border-border-soft bg-surface p-3">
      <div className="mb-2 text-xs font-semibold text-text-primary">{t("analytics.recordCost")}</div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <select
          value={source}
          onChange={(e) => setSource(e.target.value as SourcePlatform)}
          className="rounded-md border border-border-soft bg-background px-2 py-1.5 text-xs"
        >
          {SOURCE_PLATFORMS.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <input
          value={campaignId}
          onChange={(e) => setCampaignId(e.target.value)}
          placeholder={t("analytics.campaignPlaceholder")}
          className="rounded-md border border-border-soft bg-background px-2 py-1.5 text-xs"
        />
        <input
          value={cost}
          onChange={(e) => setCost(e.target.value)}
          placeholder={t("analytics.cost")}
          className="rounded-md border border-border-soft bg-background px-2 py-1.5 text-xs"
        />
        <input
          type="date"
          value={date}
          onChange={(e) => setDate(e.target.value)}
          className="rounded-md border border-border-soft bg-background px-2 py-1.5 text-xs"
        />
      </div>
      <div className="mt-2 flex items-center gap-2">
        <button
          disabled={addCost.isPending}
          onClick={submit}
          className="rounded-md bg-human px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50"
        >
          {addCost.isPending ? t("analytics.saving") : t("analytics.addCost")}
        </button>
        {addCost.isError && <span className="text-xs text-danger">{(addCost.error as Error)?.message ?? t("analytics.saveFailed")}</span>}
        {addCost.isSuccess && <span className="text-xs text-success">{t("analytics.recorded")}</span>}
      </div>
    </div>
  );
}

export function RecruitmentAnalyticsPanel() {
  const { t } = useI18n();
  const [circularId, setCircularId] = useState("");
  const [windowDaysInput, setWindowDaysInput] = useState("");
  const activeCircularId = circularId.trim() || undefined;
  const activeWindowDays = windowDaysInput.trim() ? Number(windowDaysInput) : undefined;

  const sources = useSourceEffectiveness({ circular_id: activeCircularId, time_window_days: activeWindowDays });
  const funnel = useFunnelAnalysis(activeCircularId ?? null);
  const qualityHire = useQualityHireCost({ time_window_days: activeWindowDays });

  if (!getToken()) return <EmptyState message={t("analytics.tokenRequired")} />;

  return (
    <div className="flex flex-col gap-4">
      <ConfigureAnalytics />
      <AddSourceCost />

      <div className="rounded-lg border border-border-soft bg-surface p-3">
        <div className="mb-2 text-xs font-semibold text-text-primary">{t("analytics.reportFilters")}</div>
        <div className="flex flex-col gap-2 sm:flex-row">
          <input
            value={circularId}
            onChange={(e) => setCircularId(e.target.value)}
            placeholder={t("analytics.circularPlaceholder")}
            className="flex-1 rounded-md border border-border-soft bg-background px-2 py-1.5 text-xs text-text-primary"
          />
          <input
            value={windowDaysInput}
            onChange={(e) => setWindowDaysInput(e.target.value)}
            placeholder={t("analytics.timeWindowPlaceholder")}
            className="w-56 rounded-md border border-border-soft bg-background px-2 py-1.5 text-xs text-text-primary"
          />
        </div>
      </div>

      {/* Source effectiveness */}
      <div>
        <div className="mb-2 flex items-center justify-between">
          <div className="text-xs font-semibold text-text-primary">{t("analytics.sourceComparison")}</div>
          <ExportButtons report="sources" circularId={activeCircularId} timeWindowDays={activeWindowDays} />
        </div>
        {sources.isLoading && <EmptyState message={t("analytics.loadingSources")} />}
        {sources.isError && <EmptyState message={t("analytics.apiError")} tone="danger" />}
        {sources.data && (
          <>
            <SourceComparisonTable sources={sources.data.sources} />
            <div className="mt-2 text-[11px] text-text-secondary">{sources.data.reason_description}</div>
            <div className="mt-3">
              <div className="mb-1 text-xs font-semibold text-text-primary">{t("analytics.underperformance")}</div>
              <FlagsList flags={sources.data.flags} />
            </div>
          </>
        )}
      </div>

      {/* Funnel */}
      <div>
        <div className="mb-2 flex items-center justify-between">
          <div className="text-xs font-semibold text-text-primary">{t("analytics.funnel")}</div>
          {activeCircularId && <ExportButtons report="funnel" circularId={activeCircularId} />}
        </div>
        {!activeCircularId && <EmptyState message={t("analytics.funnelPrompt")} />}
        {activeCircularId && funnel.isLoading && <EmptyState message={t("analytics.loadingFunnel")} />}
        {activeCircularId && funnel.isError && <EmptyState message={t("analytics.apiError")} tone="danger" />}
        {activeCircularId && funnel.data && (
          <div className="rounded-lg border border-border-soft bg-surface p-3">
            <FunnelView stages={funnel.data.stages} />
            <div className="mt-2 text-[11px] text-text-secondary">{funnel.data.reason_description}</div>
          </div>
        )}
      </div>

      {/* Cost per quality hire */}
      <div>
        <div className="mb-2 flex items-center justify-between">
          <div className="text-xs font-semibold text-text-primary">{t("analytics.costPerQuality")}</div>
          <ExportButtons report="quality-hire" timeWindowDays={activeWindowDays} />
        </div>
        {qualityHire.isLoading && <EmptyState message={t("analytics.loadingCost")} />}
        {qualityHire.isError && <EmptyState message={t("analytics.apiError")} tone="danger" />}
        {qualityHire.data && (
          <>
            <QualityHireTable sources={qualityHire.data.sources} />
            <div className="mt-2 text-[11px] text-text-secondary">{qualityHire.data.reason_description}</div>
            <div className="mt-3">
              <div className="mb-1 text-xs font-semibold text-text-primary">{t("analytics.costAlerts")}</div>
              <FlagsList flags={qualityHire.data.flags} />
            </div>
          </>
        )}
      </div>
    </div>
  );
}
