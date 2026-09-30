/**
 * Quest 05 Part 6 — Brain Studio: no-code rule pack editor.
 *
 * Sub-components:
 *   BrainStudio       — top-level container (list → editor flow)
 *   RulesList          — all org rule packs with version/rule counts
 *   RulePackEditor     — edit a pack's rules, grouped by category
 *   RuleCard           — plain-language card with toggle/clone/delete
 *   RuleEditor         — guided step-by-step rule creation form
 *   ConflictChecker    — visual conflict display, blocks publish
 *   VersionHistory     — visual audit rail of versions
 *   SimulationPanel    — test draft rules against sample candidates
 *   PublishButton      — publish with reason (min 10 chars)
 */
import { useState, useEffect, useCallback } from "react";
import { API_V1, authedRequest } from "../api/client";
import { getIcon } from "./navigation/iconRegistry";
import { Icon } from "./navigation/Icon";
import { ReasonCode } from "./ReasonCode";
import { useI18n } from "../i18n";

// ─── Types ───────────────────────────────────────────────────────────

interface RulePack {
  rule_pack_id: string;
  org_id: string;
  name: string;
  sector: string;
  circular_id: string | null;
  is_active: boolean;
  created_by: string | null;
  created_at: string;
  version_count?: number;
  latest_version?: number;
}

interface RulePackVersion {
  version_id: string;
  rule_pack_id: string;
  version_number: number;
  change_summary: string | null;
  created_by: string | null;
  created_at: string;
  rule_count?: number;
}

interface Rule {
  rule_id: string;
  rule_pack_version_id: string;
  rule_code: string;
  rule_type: RuleType;
  field_path: string;
  operator: Operator;
  threshold_type: string;
  threshold_value: unknown;
  review_margin: number | null;
  min_confidence_threshold: number;
  fail_reason_code: string;
  is_knockout: boolean;
  weight: number | null;
  active: boolean;
  created_at: string;
}

type RuleType = "ELIGIBILITY" | "QUOTA" | "SCORING" | "KNOCKOUT" | "WORKFLOW" | "COMMUNICATION" | "VERIFICATION";
type Operator = "EQ" | "NEQ" | "LT" | "LTE" | "GT" | "GTE" | "IN" | "NOT_IN" | "REGEX";

interface Conflict {
  rule_a: string;
  rule_b: string;
  reason: string;
}

interface SimResult {
  candidate_index: number;
  overall: "PASS" | "FAIL" | "KNOCKOUT" | "NEEDS_REVIEW";
  pass: number;
  fail: number;
  needs_review: number;
  rule_results: Array<{
    rule_id: string;
    rule_code: string;
    field_path: string;
    input_value: unknown;
    status: string;
    reason_code: string;
  }>;
}

// ─── Constants ───────────────────────────────────────────────────────

const RULE_TYPE_SECTIONS: { key: RuleType; labelKey: string; descriptionKey: string }[] = [
  { key: "ELIGIBILITY", labelKey: "brain.sectionEligibility", descriptionKey: "brain.descEligibility" },
  { key: "SCORING", labelKey: "brain.sectionScoring", descriptionKey: "brain.descScoring" },
  { key: "KNOCKOUT", labelKey: "brain.sectionKnockout", descriptionKey: "brain.descKnockout" },
  { key: "QUOTA", labelKey: "brain.sectionQuota", descriptionKey: "brain.descQuota" },
  { key: "WORKFLOW", labelKey: "brain.sectionWorkflow", descriptionKey: "brain.descWorkflow" },
];

const FIELD_OPTIONS = [
  { value: "age", labelKey: "brain.fieldAge" },
  { value: "education.level", labelKey: "brain.fieldEducation" },
  { value: "education.cgpa", labelKey: "brain.fieldCgpa" },
  { value: "division", labelKey: "brain.fieldDivision" },
  { value: "nationality", labelKey: "brain.fieldNationality" },
  { value: "quota", labelKey: "brain.fieldQuota" },
  { value: "experience.years", labelKey: "brain.fieldExperience" },
  { value: "exam_score", labelKey: "brain.fieldExamScore" },
  { value: "interview_score", labelKey: "brain.fieldInterviewScore" },
];

const OPERATOR_LABELS: Record<Operator, string> = {
  EQ: "brain.opEq",
  NEQ: "brain.opNeq",
  LT: "brain.opLt",
  LTE: "brain.opLte",
  GT: "brain.opGt",
  GTE: "brain.opGte",
  IN: "brain.opIn",
  NOT_IN: "brain.opNotIn",
  REGEX: "brain.opRegex",
};

const REASON_SUGGESTIONS: Record<string, string> = {
  "age.LT": "AGE_BELOW_THRESHOLD",
  "age.GTE": "AGE_MEETS_MINIMUM",
  "age.GT": "AGE_ABOVE_MINIMUM",
  "education.cgpa.GTE": "CGPA_MEETS_MINIMUM",
  "education.cgpa.LT": "CGPA_BELOW_THRESHOLD",
  "exam_score.GTE": "EXAM_SCORE_MEETS_MINIMUM",
  "nationality.EQ": "NATIONALITY_MATCH",
  "division.EQ": "DIVISION_MATCH",
};

// ─── Plain-language sentence builder ─────────────────────────────────

function buildPlainSentence(rule: Partial<Rule>, t: (key: string, vars?: Record<string, string | number>) => string): string {
  if (!rule.field_path || !rule.operator) return t("brain.configureRule");
  const field = t(FIELD_OPTIONS.find((f) => f.value === rule.field_path)?.labelKey ?? rule.field_path);
  const op = t(OPERATOR_LABELS[rule.operator as Operator] ?? rule.operator);
  const val = rule.threshold_value !== undefined ? JSON.stringify(rule.threshold_value) : "___";
  const knockout = rule.is_knockout ? ` (${t("brain.autoReject")})` : "";
  return t("brain.whyRule", { field, operator: `${op} ${val}` }) + knockout;
}

// ─── Top-level Brain Studio ──────────────────────────────────────────

export function BrainStudio() {
  const { t } = useI18n();
  const [packs, setPacks] = useState<RulePack[]>([]);
  const [selectedPackId, setSelectedPackId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadPacks = useCallback(async () => {
    setLoading(true);
    try {
      const data = await authedRequest<{ rule_packs: RulePack[] }>(`${API_V1}/rule-packs`);
      setPacks(data.rule_packs);
      setError(null);
    } catch (err: any) {
      setError(err?.message ?? t("brain.loadFailed"));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => { loadPacks(); }, [loadPacks]);

  if (loading) return <div className="py-8 text-center text-sm text-text-secondary">{t("brain.loading")}</div>;
  if (error) return <div className="py-8 text-center text-sm text-danger">{error}</div>;

  if (selectedPackId) {
    return (
      <RulePackEditor
        packId={selectedPackId}
        pack={packs.find((p) => p.rule_pack_id === selectedPackId) ?? null}
        onBack={() => { setSelectedPackId(null); loadPacks(); }}
        onChanged={loadPacks}
      />
    );
  }

  return (
    <RulesList
      packs={packs}
      onSelect={(id) => setSelectedPackId(id)}
      onCreate={loadPacks}
    />
  );
}

// ─── RulesList ───────────────────────────────────────────────────────

function RulesList({ packs, onSelect, onCreate }: {
  packs: RulePack[];
  onSelect: (id: string) => void;
  onCreate: () => void;
}) {
  const { t } = useI18n();
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [newSector, setNewSector] = useState("GOVT_NONCADRE");

  async function handleCreate() {
    if (!newName.trim()) return;
    try {
      await authedRequest(`${API_V1}/rule-packs`, {
        method: "POST",
        body: JSON.stringify({ name: newName.trim(), sector: newSector }),
      });
      setNewName("");
      setCreating(false);
      onCreate();
    } catch { /* toast in future */ }
  }

  return (
    <div className="flex h-full flex-col">
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h3 className="text-sm font-semibold text-text-primary">{t("brain.rulePacks")}</h3>
          <p className="text-xs text-text-secondary">{t("brain.subtitle")}</p>
        </div>
        <button
          onClick={() => setCreating(!creating)}
          className="rounded-md bg-agent px-3 py-1.5 text-xs font-semibold text-white hover:bg-agent/90"
        >
          {creating ? t("brain.cancel") : t("brain.newPack")}
        </button>
      </div>

      {creating && (
        <div className="mb-4 rounded-lg border border-agent/30 bg-surface p-4">
          <h4 className="mb-2 text-xs font-semibold text-text-primary">{t("brain.createPack")}</h4>
          <div className="mb-2">
            <label className="mb-1 block text-xs text-text-secondary">{t("brain.name")}</label>
            <input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              className="w-full rounded-md border border-border-soft bg-background px-3 py-1.5 text-sm text-text-primary"
              placeholder="e.g. 37th BCS Eligibility Rules"
            />
          </div>
          <div className="mb-3">
            <label className="mb-1 block text-xs text-text-secondary">{t("brain.sector")}</label>
            <select
              value={newSector}
              onChange={(e) => setNewSector(e.target.value)}
              className="rounded-md border border-border-soft bg-background px-3 py-1.5 text-sm text-text-primary"
            >
              <option value="GOVT_NONCADRE">{t("brain.sectorGovtNon")}</option>
              <option value="GOVT_CADRE">{t("brain.sectorGovt")}</option>
              <option value="PRIVATE">{t("brain.sectorPrivate")}</option>
              <option value="NGO">{t("brain.sectorNgo")}</option>
            </select>
          </div>
          <button
            onClick={handleCreate}
            disabled={!newName.trim()}
            className="rounded-md bg-agent px-4 py-1.5 text-xs font-semibold text-white disabled:opacity-50"
          >
            {t("brain.create")}
          </button>
        </div>
      )}

      {packs.length === 0 ? (
        <div className="flex flex-1 items-center justify-center rounded-md border border-dashed border-border-soft py-10">
          <div className="text-center">
            <div className="mb-2 text-3xl"><Icon icon={getIcon("Brain")} size={32} tone="system" className="mx-auto" /></div>
            <p className="text-sm font-medium text-text-secondary">{t("brain.noPacks")}</p>
            <p className="mt-1 text-xs text-text-secondary">{t("brain.noPacksHint")}</p>
          </div>
        </div>
      ) : (
        <div className="flex-1 space-y-2 overflow-auto">
          {packs.map((pack) => (
            <button
              key={pack.rule_pack_id}
              onClick={() => onSelect(pack.rule_pack_id)}
              className="w-full rounded-lg border border-border-soft bg-surface p-4 text-left transition-colors hover:border-agent/30 hover:bg-background"
            >
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-semibold text-text-primary">{pack.name}</span>
                  {pack.is_active && (
                    <span className="rounded-full bg-success/10 px-2 py-0.5 text-xs font-medium text-success">{t("brain.active")}</span>
                  )}
                </div>
                <div className="flex items-center gap-3 text-xs text-text-secondary">
                  <span>v{pack.latest_version ?? 1}</span>
                  <span>{t("brain.versions", { count: pack.version_count ?? 1 })}</span>
                </div>
              </div>
              <div className="mt-1 text-xs text-text-secondary">
                {pack.sector} · {t("brain.created")} {new Date(pack.created_at).toLocaleDateString()}
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── RulePackEditor ──────────────────────────────────────────────────

function RulePackEditor({ packId, pack, onBack, onChanged }: {
  packId: string;
  pack: RulePack | null;
  onBack: () => void;
  onChanged: () => void;
}) {
  const { t } = useI18n();
  const [versions, setVersions] = useState<RulePackVersion[]>([]);
  const [rules, setRules] = useState<Rule[]>([]);
  const [latestVersionId, setLatestVersionId] = useState<string | null>(null);
  const [conflicts, setConflicts] = useState<Conflict[]>([]);
  const [loading, setLoading] = useState(true);
  const [showRuleEditor, setShowRuleEditor] = useState(false);
  const [showSimulation, setShowSimulation] = useState(false);
  const [activeSection, setActiveSection] = useState<RuleType>("ELIGIBILITY");

  const loadDetail = useCallback(async () => {
    setLoading(true);
    try {
      const [detail, conflictData] = await Promise.all([
        authedRequest<{
          rule_pack: RulePack;
          versions: RulePackVersion[];
          rules: Rule[];
          latest_version_id: string | null;
        }>(`${API_V1}/rule-packs/${packId}`),
        authedRequest<{ conflicts: Conflict[]; clean: boolean }>(`${API_V1}/rule-packs/${packId}/conflicts`),
      ]);
      setVersions(detail.versions);
      setRules(detail.rules);
      setLatestVersionId(detail.latest_version_id);
      setConflicts(conflictData.conflicts);
      onChanged();
    } catch { /* silent */ } finally {
      setLoading(false);
    }
  }, [packId, onChanged]);

  useEffect(() => { loadDetail(); }, [loadDetail]);

  if (loading) return <div className="py-8 text-center text-sm text-text-secondary">{t("brain.loadingEditor")}</div>;

  const filteredRules = rules.filter((r) => r.rule_type === activeSection);

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="mb-4 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <button onClick={onBack} className="text-xs text-text-secondary hover:text-text-primary">← {t("brain.backToPacks")}</button>
          <h3 className="text-sm font-semibold text-text-primary">{pack?.name ?? t("brain.rulePack")}</h3>
          {pack?.is_active && (
            <span className="rounded-full bg-success/10 px-2 py-0.5 text-xs font-medium text-success">{t("brain.active")}</span>
          )}
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => setShowSimulation(!showSimulation)}
            className="rounded-md border border-border-soft px-3 py-1.5 text-xs font-medium text-text-secondary hover:bg-background"
          >
            {showSimulation ? t("brain.hideSimulator") : t("brain.simulate")}
          </button>
          <PublishButton
            packId={packId}
            versionId={latestVersionId}
            conflicts={conflicts}
            onPublished={() => { loadDetail(); }}
          />
        </div>
      </div>

      {/* Conflict banner */}
      {conflicts.length > 0 && <ConflictBanner conflicts={conflicts} rules={rules} />}

      {/* Simulation panel */}
      {showSimulation && latestVersionId && (
        <SimulationPanel packId={packId} versionId={latestVersionId} onClose={() => setShowSimulation(false)} />
      )}

      <div className="flex flex-1 gap-4 overflow-hidden">
        {/* Left: rule sections + cards */}
        <div className="flex flex-1 flex-col overflow-hidden">
          {/* Section tabs */}
          <div className="mb-3 flex gap-1">
            {RULE_TYPE_SECTIONS.map((s) => (
              <button
                key={s.key}
                onClick={() => setActiveSection(s.key)}
                className={`rounded-md px-3 py-1.5 text-xs font-medium ${
                  activeSection === s.key ? "bg-agent text-white" : "text-text-secondary hover:bg-background"
                }`}
              >
                {t(s.labelKey)}
              </button>
            ))}
          </div>

          {/* Section description */}
          <p className="mb-2 text-xs text-text-secondary">
            {t(RULE_TYPE_SECTIONS.find((s) => s.key === activeSection)?.descriptionKey ?? "")}
          </p>

          {/* Rules list */}
          <div className="flex-1 space-y-2 overflow-auto">
            {filteredRules.length === 0 ? (
              <div className="rounded-md border border-dashed border-border-soft py-6 text-center">
                <p className="text-xs text-text-secondary">{t("brain.noRules", { type: activeSection.toLowerCase() })}</p>
              </div>
            ) : (
              filteredRules.map((rule) => (
                <RuleCard
                  key={rule.rule_id}
                  rule={rule}
                  onToggle={async () => {
                    await authedRequest(`${API_V1}/rules/${rule.rule_id}`, {
                      method: "PATCH",
                      body: JSON.stringify({ active: !rule.active, change_summary: "Toggled via Brain Studio" }),
                    });
                    loadDetail();
                  }}
                  onDelete={async () => {
                    await authedRequest(`${API_V1}/rules/${rule.rule_id}`, {
                      method: "PATCH",
                      body: JSON.stringify({ active: false, change_summary: "Deleted via Brain Studio" }),
                    });
                    loadDetail();
                  }}
                  onClone={async () => {
                    await authedRequest(`${API_V1}/rules`, {
                      method: "POST",
                      body: JSON.stringify({
                        rule_pack_version_id: latestVersionId,
                        rule_code: `${rule.rule_code}_COPY`,
                        rule_type: rule.rule_type,
                        field_path: rule.field_path,
                        operator: rule.operator,
                        threshold_type: rule.threshold_type,
                        threshold_value: rule.threshold_value,
                        review_margin: rule.review_margin,
                        min_confidence_threshold: rule.min_confidence_threshold,
                        fail_reason_code: rule.fail_reason_code,
                        is_knockout: rule.is_knockout,
                        weight: rule.weight,
                      }),
                    });
                    loadDetail();
                  }}
                />
              ))
            )}
          </div>

          {/* Add rule button */}
          {!showRuleEditor && (
            <button
              onClick={() => setShowRuleEditor(true)}
              className="mt-3 rounded-md border border-dashed border-border-soft py-2 text-xs font-medium text-text-secondary hover:border-agent/50 hover:text-agent"
            >
              {t("brain.addRule", { type: activeSection })}
            </button>
          )}

          {/* Inline rule editor */}
          {showRuleEditor && latestVersionId && (
            <RuleEditor
              versionId={latestVersionId}
              defaultType={activeSection}
              onSaved={() => { setShowRuleEditor(false); loadDetail(); }}
              onCancel={() => setShowRuleEditor(false)}
            />
          )}
        </div>

        {/* Right: version history rail */}
        <div className="w-64 flex-shrink-0 overflow-auto">
          <VersionHistory versions={versions} />
        </div>
      </div>
    </div>
  );
}

// ─── RuleCard ────────────────────────────────────────────────────────

function RuleCard({ rule, onToggle, onDelete, onClone }: {
  rule: Rule;
  onToggle: () => void;
  onDelete: () => void;
  onClone: () => void;
}) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const sentence = buildPlainSentence(rule, t);

  return (
    <div className={`rounded-lg border ${rule.active ? "border-border-soft" : "border-border-soft opacity-50"} bg-surface p-3`}>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-xs text-text-secondary">⠿</span>
          <p className="text-sm text-text-primary">{sentence}</p>
        </div>
        <div className="flex items-center gap-2">
          {/* Active/paused toggle */}
          <button
            onClick={onToggle}
            className={`rounded px-2 py-0.5 text-xs font-medium ${
              rule.active ? "bg-success/10 text-success" : "bg-text-secondary/10 text-text-secondary"
            }`}
          >
            {rule.active ? t("brain.active") : t("brain.paused")}
          </button>
          {/* Clone */}
          <button onClick={onClone} className="text-xs text-text-secondary hover:text-agent" title={t("brain.clone")}><Icon icon={getIcon("Copy")} size={14} tone="neutral" /></button>
          {/* Delete */}
          <button onClick={onDelete} className="text-xs text-text-secondary hover:text-human" title={t("brain.deactivate")}><Icon icon={getIcon("X")} size={14} tone="neutral" /></button>
          {/* Expand */}
          <button onClick={() => setExpanded(!expanded)} className="text-xs text-text-secondary hover:text-text-primary">
            <Icon icon={getIcon(expanded ? "ChevronUp" : "ChevronDown")} size={14} tone="neutral" />
          </button>
        </div>
      </div>
      {/* Metadata row */}
      <div className="mt-1 flex gap-3 text-xs text-text-secondary">
        <span className="rounded bg-agent/10 px-1.5 py-0.5">{rule.rule_type}</span>
        <span>{rule.field_path} {t(OPERATOR_LABELS[rule.operator])} {JSON.stringify(rule.threshold_value)}</span>
        {rule.is_knockout && <span className="text-human">{t("brain.knockout")}</span>}
        {rule.weight != null && <span>{t("brain.weight")}: {rule.weight}</span>}
      </div>
      {/* Expanded detail */}
      {expanded && (
        <div className="mt-2 rounded bg-background p-2 text-xs text-text-secondary">
          <p><strong>{t("brain.ruleCode")}:</strong> {rule.rule_code}</p>
          <p><strong>{t("brain.failReason")}:</strong> <ReasonCode code={rule.fail_reason_code} size="sm" /></p>
          <p><strong>{t("brain.minConfidence")}:</strong> {rule.min_confidence_threshold}</p>
          {rule.review_margin != null && <p><strong>{t("brain.reviewMargin")}:</strong> ±{rule.review_margin}</p>}
          <p className="mt-1">
            <a href="#" className="text-agent hover:underline" onClick={(e) => e.preventDefault()}>
              {t("brain.whyRule", { field: rule.field_path, operator: rule.operator })}
            </a>
          </p>
        </div>
      )}
    </div>
  );
}

// ─── RuleEditor (guided step-by-step) ───────────────────────────────

function RuleEditor({ versionId, defaultType, onSaved, onCancel }: {
  versionId: string;
  defaultType: RuleType;
  onSaved: () => void;
  onCancel: () => void;
}) {
  const { t } = useI18n();
  const [step, setStep] = useState(1);
  const [fieldPath, setFieldPath] = useState("");
  const [operator, setOperator] = useState<Operator>("GTE");
  const [thresholdValue, setThresholdValue] = useState("");
  const [isKnockout, setIsKnockout] = useState(defaultType === "KNOCKOUT");
  const [weight, setWeight] = useState(defaultType === "SCORING" ? "1" : "");
  const [failReasonCode, setFailReasonCode] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Auto-suggest reason code
  useEffect(() => {
    const key = `${fieldPath}.${operator}`;
    const suggested = REASON_SUGGESTIONS[key];
    if (suggested && !failReasonCode) setFailReasonCode(suggested);
  }, [fieldPath, operator, failReasonCode]);

  const previewRule: Partial<Rule> = {
    field_path: fieldPath,
    operator,
    threshold_value: isNaN(Number(thresholdValue)) ? thresholdValue : Number(thresholdValue),
    is_knockout: isKnockout,
  };

  async function handleSave() {
    setSaving(true);
    setError(null);
    try {
      const parsedValue = isNaN(Number(thresholdValue)) ? thresholdValue : Number(thresholdValue);
      await authedRequest(`${API_V1}/rules`, {
        method: "POST",
        body: JSON.stringify({
          rule_pack_version_id: versionId,
          rule_code: `${fieldPath.replace(/\./g, "_").toUpperCase()}_${operator}_${Date.now().toString(36).slice(-4)}`,
          rule_type: isKnockout ? "KNOCKOUT" : defaultType,
          field_path: fieldPath,
          operator,
          threshold_type: "exact",
          threshold_value: parsedValue,
          min_confidence_threshold: 0.85,
          fail_reason_code: failReasonCode || "MANUAL_REVIEW_REQUIRED",
          is_knockout: isKnockout,
          weight: weight ? Number(weight) : null,
        }),
      });
      onSaved();
    } catch (err: any) {
      setError(err?.message ?? t("brain.saveFailed"));
    } finally {
      setSaving(false);
    }
  }

  const steps = [
    { num: 1, labelKey: "brain.stepField" },
    { num: 2, labelKey: "brain.stepOperator" },
    { num: 3, labelKey: "brain.stepValue" },
    { num: 4, labelKey: "brain.stepSettings" },
    { num: 5, labelKey: "brain.stepReason" },
    { num: 6, labelKey: "brain.stepPreview" },
  ];

  return (
    <div className="rounded-lg border border-agent/30 bg-surface p-4">
      <h4 className="mb-3 text-xs font-semibold text-text-primary">{t("brain.newRule")}</h4>

      {/* Step indicators */}
      <div className="mb-4 flex gap-1">
        {steps.map((s) => (
          <button
            key={s.num}
            onClick={() => setStep(s.num)}
            className={`rounded px-2 py-1 text-xs ${
              step === s.num ? "bg-agent text-white" : "bg-background text-text-secondary"
            }`}
          >
            {s.num}. {t(s.labelKey)}
          </button>
        ))}
      </div>

      {/* Step content */}
      {step === 1 && (
        <div>
          <label className="mb-1 block text-xs text-text-secondary">{t("brain.pickField")}</label>
          <select
            value={fieldPath}
            onChange={(e) => setFieldPath(e.target.value)}
            className="w-full rounded-md border border-border-soft bg-background px-3 py-2 text-sm text-text-primary"
          >
            <option value="">{t("brain.selectField")}</option>
            {FIELD_OPTIONS.map((f) => <option key={f.value} value={f.value}>{t(f.labelKey)}</option>)}
          </select>
        </div>
      )}

      {step === 2 && (
        <div>
          <label className="mb-1 block text-xs text-text-secondary">{t("brain.pickOperator")}</label>
          <div className="grid grid-cols-3 gap-2">
            {(["EQ", "NEQ", "LT", "LTE", "GT", "GTE", "IN", "NOT_IN", "REGEX"] as Operator[]).map((op) => (
              <button
                key={op}
                onClick={() => setOperator(op)}
                className={`rounded-md border px-3 py-2 text-xs ${
                  operator === op ? "border-agent bg-agent/10 text-agent" : "border-border-soft text-text-secondary hover:bg-background"
                }`}
              >
                {op} <span className="text-text-secondary">({t(OPERATOR_LABELS[op])})</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {step === 3 && (
        <div>
          <label className="mb-1 block text-xs text-text-secondary">{t("brain.enterThreshold")}</label>
          <input
            value={thresholdValue}
            onChange={(e) => setThresholdValue(e.target.value)}
            className="w-full rounded-md border border-border-soft bg-background px-3 py-2 text-sm text-text-primary"
            placeholder={operator === "IN" ? '["Dhaka","Chittagong"]' : "e.g. 30"}
          />
          <p className="mt-1 text-xs text-text-secondary">
            {fieldPath && `${t(FIELD_OPTIONS.find((f) => f.value === fieldPath)?.labelKey ?? fieldPath)} ${t(OPERATOR_LABELS[operator])} ${thresholdValue || "___"}`}
          </p>
        </div>
      )}

      {step === 4 && (
        <div className="space-y-3">
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={isKnockout} onChange={(e) => setIsKnockout(e.target.checked)} />
            <span className="text-xs text-text-primary">{t("brain.knockoutRule")}</span>
          </label>
          {defaultType === "SCORING" && (
            <div>
              <label className="mb-1 block text-xs text-text-secondary">{t("brain.weight")}</label>
              <input
                type="number"
                value={weight}
                onChange={(e) => setWeight(e.target.value)}
                className="w-32 rounded-md border border-border-soft bg-background px-3 py-1.5 text-sm text-text-primary"
                placeholder="1.0"
              />
            </div>
          )}
        </div>
      )}

      {step === 5 && (
        <div>
          <label className="mb-1 block text-xs text-text-secondary">{t("brain.failReasonCode")}</label>
          <input
            value={failReasonCode}
            onChange={(e) => setFailReasonCode(e.target.value)}
            className="w-full rounded-md border border-border-soft bg-background px-3 py-2 text-sm text-text-primary"
            placeholder="e.g. AGE_BELOW_THRESHOLD"
          />
          <p className="mt-1 text-xs text-text-secondary">
            {t("brain.suggested")}: {REASON_SUGGESTIONS[`${fieldPath}.${operator}`] ?? "MANUAL_REVIEW_REQUIRED"}
          </p>
        </div>
      )}

      {step === 6 && (
        <div>
          <label className="mb-1 block text-xs text-text-secondary">{t("brain.preview")}</label>
          <div className="rounded-md border border-border-soft bg-background p-3">
            <p className="text-sm font-medium text-text-primary">{buildPlainSentence(previewRule, t)}</p>
            <div className="mt-2 text-xs text-text-secondary">
              <p>Type: {isKnockout ? "KNOCKOUT" : defaultType}</p>
              <p>Reason: {failReasonCode || "MANUAL_REVIEW_REQUIRED"}</p>
            </div>
          </div>
        </div>
      )}

      {/* Error */}
      {error && <p className="mt-2 text-xs text-danger">{error}</p>}

      {/* Actions */}
      <div className="mt-4 flex justify-between">
        <button onClick={onCancel} className="text-xs text-text-secondary hover:text-text-primary">{t("brain.cancel")}</button>
        <div className="flex gap-2">
          {step > 1 && (
            <button onClick={() => setStep(step - 1)} className="rounded-md border border-border-soft px-3 py-1.5 text-xs text-text-secondary hover:bg-background">
              {t("brain.back")}
            </button>
          )}
          {step < 6 ? (
            <button onClick={() => setStep(step + 1)} className="rounded-md bg-agent px-3 py-1.5 text-xs font-semibold text-white">
              {t("brain.next")}
            </button>
          ) : (
            <button
              onClick={handleSave}
              disabled={saving || !fieldPath || !thresholdValue}
              className="rounded-md bg-agent px-4 py-1.5 text-xs font-semibold text-white disabled:opacity-50"
            >
              {saving ? t("brain.saving") : t("brain.saveRule")}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── ConflictChecker (banner) ────────────────────────────────────────

function ConflictBanner({ conflicts, rules }: { conflicts: Conflict[]; rules: Rule[] }) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="mb-3 rounded-lg border border-human/30 bg-human/5 p-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-human"><Icon icon={getIcon("AlertTriangle")} size={16} tone="human" /></span>
          <span className="text-sm font-semibold text-human">
            {t("brain.conflictsDetected", { count: conflicts.length })}
          </span>
        </div>
        <button onClick={() => setExpanded(!expanded)} className="text-xs text-human hover:underline">
          {expanded ? t("brain.hide") : t("brain.details")}
        </button>
      </div>
      <p className="mt-1 text-xs text-text-secondary">{t("brain.publishBlocked")}</p>
      {expanded && (
        <div className="mt-2 space-y-1">
          {conflicts.map((c, i) => {
            const ruleA = rules.find((r) => r.rule_id === c.rule_a);
            const ruleB = rules.find((r) => r.rule_id === c.rule_b);
            return (
              <div key={i} className="rounded bg-background p-2 text-xs">
                <p className="font-medium text-human">{c.reason}</p>
                <div className="mt-1 flex gap-4 text-text-secondary">
                  <span>{t("brain.ruleA")}: <a href="#" className="text-agent hover:underline" onClick={(e) => e.preventDefault()}>{ruleA?.rule_code ?? c.rule_a}</a></span>
                  <span>{t("brain.ruleB")}: <a href="#" className="text-agent hover:underline" onClick={(e) => e.preventDefault()}>{ruleB?.rule_code ?? c.rule_b}</a></span>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ─── VersionHistory ──────────────────────────────────────────────────

function VersionHistory({ versions }: { versions: RulePackVersion[] }) {
  const { t } = useI18n();
  if (versions.length === 0) return null;

  return (
    <div className="rounded-lg border border-border-soft bg-surface p-3">
      <h4 className="mb-2 text-xs font-semibold text-text-primary">{t("brain.versionHistory")}</h4>
      <div className="space-y-0">
        {versions.map((v, i) => (
          <div key={v.version_id} className="relative flex gap-3 pb-4">
            {/* Rail line */}
            {i < versions.length - 1 && (
              <div className="absolute left-[7px] top-4 h-full w-px bg-border-soft" />
            )}
            {/* Dot */}
            <div className={`mt-1 h-3.5 w-3.5 flex-shrink-0 rounded-full border-2 ${
              i === 0 ? "border-agent bg-agent/20" : "border-border-soft bg-background"
            }`} />
            {/* Content */}
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="text-xs font-semibold text-text-primary">v{v.version_number}</span>
                {i === 0 && <span className="rounded bg-agent/10 px-1.5 py-0.5 text-[10px] text-agent">{t("brain.latest")}</span>}
              </div>
              {v.change_summary && (
                <p className="mt-0.5 truncate text-xs text-text-secondary">{v.change_summary}</p>
              )}
              <p className="text-[10px] text-text-secondary/60">
                {new Date(v.created_at).toLocaleString()}
                {v.rule_count !== undefined && ` · ${t("brain.rules", { count: v.rule_count })}`}
              </p>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── SimulationPanel ─────────────────────────────────────────────────

function SimulationPanel({ packId, versionId, onClose }: {
  packId: string;
  versionId: string;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [candidates, setCandidates] = useState([
    { name: "Sample 1", age: 28, cgpa: 3.5, nationality: "Bangladeshi" },
    { name: "Sample 2", age: 35, cgpa: 2.8, nationality: "Bangladeshi" },
    { name: "Sample 3", age: 22, cgpa: 3.9, nationality: "Indian" },
  ]);
  const [editingIdx, setEditingIdx] = useState<number | null>(null);
  const [results, setResults] = useState<SimResult[] | null>(null);
  const [summary, setSummary] = useState<{ total: number; pass: number; fail: number; needs_review: number; rule_count: number } | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function runSimulation() {
    setRunning(true);
    setError(null);
    try {
      const data = await authedRequest<{
        summary: typeof summary;
        results: SimResult[];
      }>(`${API_V1}/rule-packs/${packId}/simulate`, {
        method: "POST",
        body: JSON.stringify({
          version_id: versionId,
          candidates: candidates.map((c) => ({ ...c })),
        }),
      });
      setResults(data.results);
      setSummary(data.summary);
    } catch (err: any) {
      setError(err?.message ?? t("brain.simFailed"));
    } finally {
      setRunning(false);
    }
  }

  const STATUS_COLORS: Record<string, string> = {
    PASS: "bg-success/10 text-success",
    FAIL: "bg-human/10 text-human",
    KNOCKOUT: "bg-human/10 text-human",
    NEEDS_REVIEW: "bg-attention/10 text-attention",
  };

  return (
    <div className="mb-4 rounded-lg border border-agent/20 bg-surface p-4">
      <div className="mb-3 flex items-center justify-between">
        <h4 className="text-xs font-semibold text-text-primary">{t("brain.simPanel")}</h4>
        <button onClick={onClose} className="text-xs text-text-secondary hover:text-text-primary"><Icon icon={getIcon("X")} size={14} tone="neutral" /></button>
      </div>

      <p className="mb-2 text-xs text-text-secondary">
        {t("brain.simHint")}
      </p>

      {/* Sample candidates */}
      <div className="mb-3 space-y-1">
        {candidates.map((c, i) => (
          <div key={i} className="flex items-center gap-2">
            <button
              onClick={() => setEditingIdx(editingIdx === i ? null : i)}
              className="w-full rounded border border-border-soft bg-background px-2 py-1 text-left text-xs text-text-primary"
            >
              {c.name}: age={c.age}, cgpa={c.cgpa}, nationality={c.nationality}
            </button>
          </div>
        ))}
      </div>

      {/* Edit candidate */}
      {editingIdx !== null && (
        <div className="mb-3 rounded bg-background p-2">
          <p className="mb-1 text-xs font-medium text-text-secondary">Edit {candidates[editingIdx].name}</p>
          {Object.entries(candidates[editingIdx]).map(([key, val]) => (
            <label key={key} className="mr-2 inline-block text-xs">
              {key}:{" "}
              <input
                value={String(val)}
                onChange={(e) => {
                  const updated = [...candidates];
                  updated[editingIdx] = { ...updated[editingIdx], [key]: isNaN(Number(e.target.value)) ? e.target.value : Number(e.target.value) };
                  setCandidates(updated);
                }}
                className="w-20 rounded border border-border-soft bg-surface px-1 py-0.5 text-xs text-text-primary"
              />
            </label>
          ))}
        </div>
      )}

      <button
        onClick={runSimulation}
        disabled={running}
        className="mb-3 rounded-md bg-agent px-4 py-1.5 text-xs font-semibold text-white disabled:opacity-50"
      >
        {running ? t("brain.running") : t("brain.runSim")}
      </button>

      {error && <p className="mb-2 text-xs text-danger">{error}</p>}

      {/* Results */}
      {results && summary && (
        <div>
          <div className="mb-2 flex gap-3 text-xs">
            <span className="rounded bg-success/10 px-2 py-0.5 text-success">{summary.pass} {t("brain.pass")}</span>
            <span className="rounded bg-human/10 px-2 py-0.5 text-human">{summary.fail} {t("brain.fail")}</span>
            <span className="rounded bg-attention/10 px-2 py-0.5 text-attention">{summary.needs_review} {t("brain.review")}</span>
            <span className="text-text-secondary">{t("brain.rulesTested", { count: summary.rule_count })}</span>
          </div>
          <div className="space-y-1">
            {results.map((r) => (
              <div key={r.candidate_index} className="rounded bg-background p-2 text-xs">
                <div className="flex items-center justify-between">
                  <span className="text-text-primary">{t("brain.candidateNum", { num: r.candidate_index + 1 })}</span>
                  <span className={`rounded px-2 py-0.5 font-medium ${STATUS_COLORS[r.overall] ?? ""}`}>
                    {r.overall}
                  </span>
                </div>
                <div className="mt-1 flex gap-2 text-text-secondary">
                  <span>{r.pass} {t("brain.pass")}</span>
                  <span>{r.fail} {t("brain.fail")}</span>
                  <span>{r.needs_review} {t("brain.review")}</span>
                </div>
                {/* Rule-level detail */}
                <div className="mt-1 space-y-0.5">
                  {r.rule_results.map((rr) => (
                    <div key={rr.rule_id} className="flex items-center gap-2 text-[10px]">
                      <span className={`rounded px-1 ${STATUS_COLORS[rr.status] ?? "text-text-secondary"}`}>
                        {rr.status}
                      </span>
                      <span className="text-text-secondary">{rr.rule_code}</span>
                      <span className="text-text-secondary/60">
                        {rr.field_path}={JSON.stringify(rr.input_value)} → <ReasonCode code={rr.reason_code} size="sm" />
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── PublishButton ───────────────────────────────────────────────────

function PublishButton({ packId, versionId, conflicts, onPublished }: {
  packId: string;
  versionId: string | null;
  conflicts: Conflict[];
  onPublished: () => void;
}) {
  const { t } = useI18n();
  const [showForm, setShowForm] = useState(false);
  const [reason, setReason] = useState("");
  const [publishing, setPublishing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const blocked = conflicts.length > 0;

  async function handlePublish() {
    if (!versionId || reason.trim().length < 10) return;
    setPublishing(true);
    setError(null);
    try {
      await authedRequest(`${API_V1}/rule-packs/${packId}/publish`, {
        method: "POST",
        body: JSON.stringify({ version_id: versionId }),
      });
      setShowForm(false);
      setReason("");
      onPublished();
    } catch (err: any) {
      setError(err?.message ?? t("brain.publishFailed"));
    } finally {
      setPublishing(false);
    }
  }

  return (
    <div className="relative">
      <button
        onClick={() => setShowForm(!showForm)}
        disabled={blocked}
        className={`rounded-md px-4 py-1.5 text-xs font-semibold text-white ${
          blocked ? "cursor-not-allowed bg-text-secondary/30" : "bg-agent hover:bg-agent/90"
        }`}
        title={blocked ? t("brain.resolveConflicts") : t("brain.publishVersion")}
      >
        {blocked ? t("brain.blocked") : t("brain.publish")}
      </button>

      {showForm && (
        <div className="absolute right-0 top-full z-10 mt-2 w-72 rounded-lg border border-border-soft bg-surface p-4 shadow-lg">
          <h4 className="mb-2 text-xs font-semibold text-text-primary">{t("brain.publishPack")}</h4>
          <label className="mb-1 block text-xs text-text-secondary">{t("brain.reasonMin")}</label>
          <textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={3}
            className="w-full rounded-md border border-border-soft bg-background px-3 py-2 text-sm text-text-primary"
            placeholder="e.g. Updated eligibility criteria per HR directive 2024-03"
          />
          <p className="mt-1 text-right text-xs text-text-secondary">{reason.length}/{t("brain.minLabel", { count: 10 })}</p>
          {error && <p className="mt-1 text-xs text-danger">{error}</p>}
          <div className="mt-2 flex justify-end gap-2">
            <button onClick={() => { setShowForm(false); setReason(""); setError(null); }} className="text-xs text-text-secondary hover:text-text-primary">
              {t("brain.cancel")}
            </button>
            <button
              onClick={handlePublish}
              disabled={publishing || reason.trim().length < 10}
              className="rounded-md bg-agent px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50"
            >
              {publishing ? t("brain.publishing") : t("brain.confirmPublish")}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
