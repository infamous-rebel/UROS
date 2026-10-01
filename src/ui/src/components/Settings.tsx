/**
 * Quest 05 Part 7 — Settings: 12-tab consolidated control center.
 *
 * Layout: left sidebar with 12 tab labels, right panel = active tab.
 * Each tab is a self-contained component that fetches its own data.
 *
 * Tabs:
 *  1. Profile       2. Organization   3. Users
 *  4. Credentials   5. Fallback       6. Integrations
 *  7. Personas      8. KPI Templates  9. Onboarding
 * 10. Backup       11. Audit         12. Data Export
 */
import { useState, useEffect, useCallback } from "react";
import { API_V1, authedRequest } from "../api/client";
import { DownloadButton } from "./DownloadButton";
import { useTheme } from "../theme/ThemeContext";
import type { ThemeMode } from "../theme/ThemeContext";
import { getIcon } from "./navigation/iconRegistry";
import { Icon } from "./navigation/Icon";
import { useI18n } from "../i18n";

type SettingsTab = "profile" | "organization" | "users" | "credentials" | "fallback" |
  "integrations" | "personas" | "kpi" | "onboarding" | "backup" | "audit" | "export";

const TABS: { key: SettingsTab; labelKey: string; icon: string }[] = [
  { key: "profile", labelKey: "settings.tabProfile", icon: "User" },
  { key: "organization", labelKey: "settings.tabOrganization", icon: "Building2" },
  { key: "users", labelKey: "settings.tabUsers", icon: "Users" },
  { key: "credentials", labelKey: "settings.tabCredentials", icon: "Key" },
  { key: "fallback", labelKey: "settings.tabFallback", icon: "Link" },
  { key: "integrations", labelKey: "settings.tabIntegrations", icon: "Plug" },
  { key: "personas", labelKey: "settings.tabPersonas", icon: "VenetianMask" },
  { key: "kpi", labelKey: "settings.tabKpi", icon: "BarChart3" },
  { key: "onboarding", labelKey: "settings.tabOnboarding", icon: "CircleCheck" },
  { key: "backup", labelKey: "settings.tabBackup", icon: "HardDrive" },
  { key: "audit", labelKey: "settings.tabAudit", icon: "ClipboardList" },
  { key: "export", labelKey: "settings.tabExport", icon: "Package" },
];

export function Settings() {
  const [tab, setTab] = useState<SettingsTab>("profile");
  const { t } = useI18n();

  return (
    <div className="flex h-full gap-4">
      {/* Sidebar */}
      <nav className="w-48 flex-shrink-0 space-y-0.5 overflow-auto">
        {TABS.map((tabItem) => (
          <button
            key={tabItem.key}
            onClick={() => setTab(tabItem.key)}
            className={`flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-xs font-medium transition-colors ${
              tab === tabItem.key ? "bg-agent text-white" : "text-text-secondary hover:bg-background hover:text-text-primary"
            }`}
          >
            <Icon icon={getIcon(tabItem.icon)} size={16} tone="neutral" />
            <span>{t(tabItem.labelKey)}</span>
          </button>
        ))}
      </nav>

      {/* Content */}
      <div className="flex-1 overflow-auto rounded-lg border border-border-soft bg-surface p-4">
        {tab === "profile" && <ProfileTab />}
        {tab === "organization" && <OrganizationTab />}
        {tab === "users" && <UsersTab />}
        {tab === "credentials" && <CredentialsTab />}
        {tab === "fallback" && <FallbackTab />}
        {tab === "integrations" && <IntegrationsTab />}
        {tab === "personas" && <PersonasTab />}
        {tab === "kpi" && <KpiTab />}
        {tab === "onboarding" && <OnboardingTab />}
        {tab === "backup" && <BackupTab />}
        {tab === "audit" && <AuditTab />}
        {tab === "export" && <ExportTab />}
      </div>
    </div>
  );
}

// ─── Shared helpers ──────────────────────────────────────────────────

function SectionTitle({ title, description }: { title: string; description?: string }) {
  return (
    <div className="mb-4">
      <h3 className="text-sm font-semibold text-text-primary">{title}</h3>
      {description && <p className="mt-0.5 text-xs text-text-secondary">{description}</p>}
    </div>
  );
}

function EmptyState({ message }: { message: string }) {
  return (
    <div className="flex items-center justify-center rounded-md border border-dashed border-border-soft py-8">
      <p className="text-sm text-text-secondary">{message}</p>
    </div>
  );
}

function SaveButton({ onClick, saving, label }: { onClick: () => void; saving: boolean; label?: string }) {
  const { t } = useI18n();
  return (
    <button
      onClick={onClick}
      disabled={saving}
      className="rounded-md bg-agent px-4 py-1.5 text-xs font-semibold text-white disabled:opacity-50"
    >
      {saving ? t("settings.saving") : (label ?? t("settings.save"))}
    </button>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="mb-3">
      <label className="mb-1 block text-xs font-medium text-text-secondary">{label}</label>
      {children}
    </div>
  );
}

const inputClass = "w-full rounded-md border border-border-soft bg-background px-3 py-1.5 text-sm text-text-primary focus:border-agent focus:outline-none focus:ring-1 focus:ring-agent";
const inputClassError = "w-full rounded-md border border-danger bg-background px-3 py-1.5 text-sm text-text-primary focus:border-danger focus:outline-none focus:ring-1 focus:ring-danger";

function FieldError({ message }: { message: string }) {
  return <p className="mt-1 text-xs text-danger">{message}</p>;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// ─── 1. Profile Tab ──────────────────────────────────────────────────

function ProfileTab() {
  const { t } = useI18n();
  const [user, setUser] = useState<any>(null);
  const [sessions, setSessions] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [errors, setErrors] = useState<{ name?: string; phone?: string }>({});

  const load = useCallback(async () => {
    try {
      const [profileRes, sessRes] = await Promise.all([
        authedRequest<any>(`${API_V1}/settings/me/profile`),
        authedRequest<any>(`${API_V1}/users/me/sessions`),
      ]);
      setUser(profileRes.user);
      setName(profileRes.user.full_name ?? "");
      setPhone(profileRes.user.phone ?? "");
      setSessions(sessRes.sessions ?? []);
    } catch { /* silent */ } finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  if (loading) return <p className="text-sm text-text-secondary">{t("settings.loadingProfile")}</p>;
  if (!user) return <EmptyState message={t("settings.profileLoadFailed")} />;

  async function handleSave() {
    const errs: { name?: string; phone?: string } = {};
    if (!name.trim()) errs.name = t("settings.required");
    if (phone && phone.length < 6) errs.phone = t("settings.phoneOptionalHint");
    if (Object.keys(errs).length > 0) { setErrors(errs); return; }
    setErrors({});
    setSaving(true);
    try {
      await authedRequest(`${API_V1}/settings/me/profile`, {
        method: "PATCH",
        body: JSON.stringify({ full_name: name, phone: phone || null }),
      });
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch { /* silent */ } finally { setSaving(false); }
  }

  async function handleRevoke(sessionId: string) {
    await authedRequest(`${API_V1}/users/me/sessions/${sessionId}`, { method: "DELETE" });
    load();
  }

  return (
    <div>
      <SectionTitle title={t("settings.profile")} description={t("settings.profileDesc")} />
      <Field label={t("settings.fullName")}>
        <input value={name} onChange={(e) => { setName(e.target.value); setErrors({}); }} className={errors.name ? inputClassError : inputClass} />
        {errors.name && <FieldError message={errors.name} />}
      </Field>
      <Field label={t("settings.email")}>
        <input value={user.email} disabled className={`${inputClass} opacity-50`} />
      </Field>
      <Field label={t("settings.phone")}>
        <input value={phone} onChange={(e) => { setPhone(e.target.value); setErrors((prev) => ({ ...prev, phone: undefined })); }} className={errors.phone ? inputClassError : inputClass} placeholder="+880…" />
        {errors.phone && <FieldError message={errors.phone} />}
      </Field>
      <Field label={t("settings.role")}>
        <input value={user.role} disabled className={`${inputClass} opacity-50`} />
      </Field>

      {/* Quest 05 Part 14 — Theme switcher */}
      <ThemeSwitcher />

      <div className="flex items-center gap-3">
        <SaveButton onClick={handleSave} saving={saving} />
        {saved && <span className="text-xs text-success"><Icon icon={getIcon("Check")} size={12} tone="system" className="inline mr-1" />{t("settings.saved")}</span>}
      </div>

      {/* Sessions */}
      <div className="mt-6">
        <h4 className="mb-2 text-xs font-semibold text-text-primary">{t("settings.activeSessions")}</h4>
        {sessions.length === 0 ? (
          <EmptyState message={t("settings.noSessions")} />
        ) : (
          <div className="space-y-1">
            {sessions.map((s: any) => (
              <div key={s.session_id} className="flex items-center justify-between rounded bg-background p-2 text-xs">
                <div>
                  <span className={s.current ? "font-semibold text-agent" : "text-text-primary"}>
                    {s.current ? t("settings.currentSession") : s.session_id.slice(0, 12) + "…"}
                  </span>
                  <span className="ml-2 text-text-secondary">{s.ip} · {new Date(s.created_at).toLocaleDateString()}</span>
                </div>
                {!s.current && (
                  <button onClick={() => handleRevoke(s.session_id)} className="text-human hover:underline">{t("settings.revoke")}</button>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Theme Switcher (Quest 05 Part 14) ──────────────────────────────

function ThemeSwitcher() {
  const { t } = useI18n();
  const { mode, resolved, setMode } = useTheme();
  const options: { value: ThemeMode; label: string }[] = [
    { value: "light", label: t("theme.light") },
    { value: "dark", label: t("theme.dark") },
    { value: "system", label: t("theme.system") },
  ];
  return (
    <div className="mb-4">
      <label className="mb-1 block text-xs font-medium text-text-secondary">{t("settings.theme")}</label>
      <div className="flex gap-1">
        {options.map((opt) => (
          <button
            key={opt.value}
            onClick={() => setMode(opt.value)}
            className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
              mode === opt.value
                ? "bg-agent text-white"
                : "bg-background text-text-secondary hover:bg-background-hover hover:text-text-primary"
            }`}
          >
            {opt.label}
            {opt.value === "system" && resolved === "dark" && " (" + t("theme.dark") + ")"}
            {opt.value === "system" && resolved === "light" && " (" + t("theme.light") + ")"}
          </button>
        ))}
      </div>
      <p className="mt-1 text-xs text-text-tertiary">{t("theme.description")}</p>
    </div>
  );
}

// ─── 2. Organization tab ─────────────────────────────────────────────

function OrganizationTab() {
  const { t } = useI18n();
  const [org, setOrg] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [name, setName] = useState("");
  const [sector, setSector] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await authedRequest<any>(`${API_V1}/settings/me`);
      setOrg(res.organization);
      setName(res.organization.name ?? "");
      setSector(res.organization.sector ?? "");
    } catch { /* */ } finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  if (loading) return <p className="text-sm text-text-secondary">{t("settings.loading")}</p>;
  if (!org) return <EmptyState message={t("settings.orgLoadFailed")} />;

  async function handleSave() {
    setSaving(true);
    try {
      await authedRequest(`${API_V1}/settings/me`, {
        method: "PATCH",
        body: JSON.stringify({ name, sector }),
      });
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch { /* */ } finally { setSaving(false); }
  }

  return (
    <div>
      <SectionTitle title={t("settings.organization")} description={t("settings.orgDesc")} />
      <Field label={t("settings.orgName")}>
        <input value={name} onChange={(e) => setName(e.target.value)} className={inputClass} />
      </Field>
      <Field label={t("settings.sector")}>
        <select value={sector} onChange={(e) => setSector(e.target.value)} className={inputClass}>
          <option value="GOVT_NONCADRE">{t("brain.sectorGovtNon")}</option>
          <option value="BCS">BCS</option>
          <option value="STATE_BANK">State Bank</option>
          <option value="PRIVATE_BANK">Private Bank</option>
          <option value="CORPORATE">Corporate</option>
          <option value="NGO">NGO</option>
          <option value="SME">SME</option>
        </select>
      </Field>
      <Field label={t("settings.deploymentMode")}>
        <input value={org.deployment_mode ?? "CLOUD"} disabled className={`${inputClass} opacity-50`} />
      </Field>
      <Field label={t("settings.defaultLanguage")}>
        <input value={org.default_language ?? "en"} disabled className={`${inputClass} opacity-50`} />
      </Field>
      <div className="flex items-center gap-3">
        <SaveButton onClick={handleSave} saving={saving} />
        {saved && <span className="text-xs text-success"><Icon icon={getIcon("Check")} size={12} tone="system" className="inline mr-1" />{t("settings.saved")}</span>}
      </div>
    </div>
  );
}

// ─── 3. Users Tab ────────────────────────────────────────────────────

function UsersTab() {
  const { t } = useI18n();
  const [users, setUsers] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [showInvite, setShowInvite] = useState(false);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteName, setInviteName] = useState("");
  const [inviteRole, setInviteRole] = useState("RECRUITER");
  const [inviteErrors, setInviteErrors] = useState<{ email?: string; name?: string }>({});

  const load = useCallback(async () => {
    try {
      const res = await authedRequest<any>(`${API_V1}/settings`);
      setUsers(res.users ?? []);
    } catch { /* */ } finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  if (loading) return <p className="text-sm text-text-secondary">{t("settings.loadingUsers")}</p>;

  async function handleInvite() {
    const errs: { email?: string; name?: string } = {};
    if (!inviteEmail.trim()) errs.email = t("settings.required");
    else if (!EMAIL_RE.test(inviteEmail)) errs.email = t("settings.validEmail");
    if (!inviteName.trim()) errs.name = t("settings.required");
    if (Object.keys(errs).length > 0) { setInviteErrors(errs); return; }
    setInviteErrors({});
    try {
      await authedRequest(`${API_V1}/users/invite`, {
        method: "POST",
        body: JSON.stringify({ email: inviteEmail, full_name: inviteName, role: inviteRole }),
      });
      setShowInvite(false);
      setInviteEmail("");
      setInviteName("");
      load();
    } catch { /* */ }
  }

  async function handleDeactivate(userId: string) {
    await authedRequest(`${API_V1}/settings/${userId}`, { method: "DELETE" });
    load();
  }

  return (
    <div>
      <div className="mb-4 flex items-center justify-between">
        <SectionTitle title={t("settings.users")} description={t("settings.usersDesc")} />
        <button onClick={() => setShowInvite(!showInvite)} className="rounded-md bg-agent px-3 py-1.5 text-xs font-semibold text-white">
          {showInvite ? t("settings.cancel") : t("settings.inviteUser")}
        </button>
      </div>

      {showInvite && (
        <div className="mb-4 rounded-lg border border-agent/30 bg-background p-3">
          <Field label={t("settings.email")}><input value={inviteEmail} onChange={(e) => { setInviteEmail(e.target.value); setInviteErrors({}); }} className={inviteErrors.email ? inputClassError : inputClass} type="email" />{inviteErrors.email && <FieldError message={inviteErrors.email} />}</Field>
          <Field label={t("settings.fullName")}><input value={inviteName} onChange={(e) => { setInviteName(e.target.value); setInviteErrors({}); }} className={inviteErrors.name ? inputClassError : inputClass} />{inviteErrors.name && <FieldError message={inviteErrors.name} />}</Field>
          <Field label={t("settings.role")}>
            <select value={inviteRole} onChange={(e) => setInviteRole(e.target.value)} className={inputClass}>
              <option value="ADMIN">{t("settings.roleAdmin")}</option>
              <option value="SENIOR_RECRUITER">{t("settings.roleSenior")}</option>
              <option value="RECRUITER">{t("settings.roleRecruiter")}</option>
              <option value="AUDITOR">{t("settings.roleAuditor")}</option>
              <option value="DEPT_HEAD">{t("settings.roleDeptHead")}</option>
            </select>
          </Field>
          <SaveButton onClick={handleInvite} saving={false} label={t("settings.sendInvite")} />
        </div>
      )}

      {users.length === 0 ? <EmptyState message={t("settings.noUsers")} /> : (
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-border-soft text-xs uppercase text-text-secondary">
              <th className="pb-2">{t("settings.nameCol")}</th><th className="pb-2">{t("settings.emailCol")}</th><th className="pb-2">{t("settings.roleCol")}</th><th className="pb-2">{t("settings.lastLogin")}</th><th className="pb-2 text-right">{t("settings.actions")}</th>
            </tr>
          </thead>
          <tbody>
            {users.map((u: any) => (
              <tr key={u.user_id} className="border-b border-border-soft last:border-0">
                <td className="py-2 text-text-primary">{u.full_name}</td>
                <td className="py-2 text-text-secondary">{u.email}</td>
                <td className="py-2"><span className="rounded bg-agent/10 px-1.5 py-0.5 text-xs text-agent">{u.role}</span></td>
                <td className="py-2 text-xs text-text-secondary">{u.last_login_at ? new Date(u.last_login_at).toLocaleString() : t("settings.never")}</td>
                <td className="py-2 text-right">
                  <button onClick={() => handleDeactivate(u.user_id)} className="text-xs text-human hover:underline">{t("settings.deactivate")}</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

// ─── 4. Credentials Tab ──────────────────────────────────────────────

function CredentialsTab() {
  const { t } = useI18n();
  const [creds, setCreds] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [connector, setConnector] = useState("llm");
  const [label, setLabel] = useState("default");
  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [budgetCap, setBudgetCap] = useState("");
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await authedRequest<any>(`${API_V1}/credentials`);
      setCreds(res.credentials ?? []);
    } catch { /* */ } finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  if (loading) return <p className="text-sm text-text-secondary">{t("settings.loadingCreds")}</p>;

  async function handleCreate() {
    if (!apiKey || apiKey.length < 8) return;
    setSaving(true);
    try {
      await authedRequest(`${API_V1}/credentials`, {
        method: "POST",
        body: JSON.stringify({
          connector, label, api_key: apiKey,
          base_url: baseUrl || undefined,
          budget_cap: budgetCap ? Number(budgetCap) : undefined,
        }),
      });
      setShowForm(false); setApiKey(""); setBaseUrl(""); setBudgetCap(""); setLabel("default");
      await load();
    } catch { /* */ } finally { setSaving(false); }
  }

  async function handleRotate(id: string) {
    const newKey = prompt("Enter new API key (min 8 characters):");
    if (!newKey || newKey.length < 8) return;
    try {
      await authedRequest(`${API_V1}/credentials/${id}`, {
        method: "PATCH", body: JSON.stringify({ api_key: newKey }),
      });
      await load();
    } catch { /* */ }
  }

  async function handleRevoke(id: string) {
    try {
      await authedRequest(`${API_V1}/credentials/${id}`, { method: "DELETE" });
      await load();
    } catch { /* */ }
  }

  const CONNECTORS = ["llm","email","sms_provider","whatsapp_business","bdjobs","teletalk","calendar","education_board","cib","police","sms_teletalk","sms_grameenphone","sms_banglalink","sms_robi","sms_airtel","sms_ssl_wireless","voip","email_smtp","email_imap","email_gmail_api","email_sendgrid","whatsapp_meta","bdjobs_scraper","calendar_google","calendar_outlook","teletalk_sms","teletalk_cv_bank"];

  return (
    <div>
      <div className="mb-4 flex items-center justify-between">
        <SectionTitle title={t("settings.byok")} description={t("settings.byokDesc")} />
        <button onClick={() => setShowForm(!showForm)} className="rounded-md bg-agent px-3 py-1.5 text-xs font-semibold text-white">
          {showForm ? t("common.cancel") : t("settings.addCredential")}
        </button>
      </div>
      {showForm && (
        <div className="mb-4 rounded-lg border border-agent/30 bg-background p-3">
          <Field label={t("settings.connector")}>
            <select value={connector} onChange={(e) => setConnector(e.target.value)} className={inputClass}>
              {CONNECTORS.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </Field>
          <Field label={t("settings.label")}><input value={label} onChange={(e) => setLabel(e.target.value)} className={inputClass} /></Field>
          <Field label={t("settings.apiKey")}><input value={apiKey} onChange={(e) => setApiKey(e.target.value)} className={inputClass} type="password" /></Field>
          <Field label={t("settings.baseUrl")}><input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} className={inputClass} placeholder="https://..." /></Field>
          <Field label={t("settings.budgetCap")}><input value={budgetCap} onChange={(e) => setBudgetCap(e.target.value)} className={inputClass} type="number" /></Field>
          <SaveButton onClick={handleCreate} saving={saving} label={t("common.create")} />
        </div>
      )}
      {creds.length === 0 ? <EmptyState message={t("settings.noCreds")} /> : (
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-border-soft text-xs uppercase text-text-secondary">
              <th className="pb-2">{t("settings.connector")}</th><th className="pb-2">{t("settings.label")}</th><th className="pb-2">{t("settings.keyHint")}</th><th className="pb-2">{t("settings.status")}</th><th className="pb-2">{t("settings.created")}</th><th className="pb-2 text-right">{t("settings.actions")}</th>
            </tr>
          </thead>
          <tbody>
            {creds.map((c: any) => (
              <tr key={c.credential_id} className="border-b border-border-soft last:border-0">
                <td className="py-2 font-mono text-xs text-text-primary">{c.connector}</td>
                <td className="py-2 text-text-secondary">{c.label}</td>
                <td className="py-2 font-mono text-xs text-text-secondary">{c.key_hint ?? "\u2022\u2022\u2022\u2022"}</td>
                <td className="py-2"><span className={`rounded px-1.5 py-0.5 text-xs ${c.active !== false ? "bg-success/10 text-success" : "bg-human/10 text-human"}`}>{c.active !== false ? t("settings.credActive") : t("settings.credRevoked")}</span></td>
                <td className="py-2 text-xs text-text-secondary">{new Date(c.created_at).toLocaleDateString()}</td>
                <td className="py-2 text-right">
                  {c.active !== false && (
                    <button onClick={() => handleRotate(c.credential_id)} className="mr-2 text-xs text-agent hover:underline">{t("settings.rotate")}</button>
                  )}
                  {c.active !== false && (
                    <button onClick={() => handleRevoke(c.credential_id)} className="text-xs text-human hover:underline">{t("settings.revoke")}</button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

// ─── 5. Fallback Tab ─────────────────────────────────────────────────

function FallbackTab() {
  const { t } = useI18n();
  const [chains, setChains] = useState<Record<string, string[]>>({});
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  const load = useCallback(async () => {
    try {
      const [sms, email, whatsapp] = await Promise.all([
        authedRequest<any>(`${API_V1}/integrations/fallback/SMS`),
        authedRequest<any>(`${API_V1}/integrations/fallback/EMAIL`),
        authedRequest<any>(`${API_V1}/integrations/fallback/WHATSAPP`),
      ]);
      setChains({
        SMS: sms.provider_order ?? [],
        EMAIL: email.provider_order ?? [],
        WHATSAPP: whatsapp.provider_order ?? [],
      });
    } catch { /* */ } finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  if (loading) return <p className="text-sm text-text-secondary">{t("settings.loadingFallback")}</p>;

  function startEdit(type: string) {
    setEditing(type);
    setEditValue((chains[type] ?? []).join(", "));
  }

  async function handleSave(type: string) {
    setSaving(true);
    try {
      const provider_order = editValue.split(",").map((s) => s.trim()).filter(Boolean);
      await authedRequest(`${API_V1}/integrations/fallback/${type}`, {
        method: "PUT",
        body: JSON.stringify({ provider_order }),
      });
      setEditing(null);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
      await load();
    } catch { /* */ } finally { setSaving(false); }
  }

  return (
    <div>
      <SectionTitle title={t("settings.fallback")} description={t("settings.fallbackDesc")} />
      {saved && <p className="mb-2 text-xs text-success"><Icon icon={getIcon("Check")} size={12} tone="system" className="inline mr-1" />{t("settings.chainSaved")}</p>}
      {(["SMS", "EMAIL", "WHATSAPP"] as const).map((type) => (
        <div key={type} className="mb-4 rounded-lg border border-border-soft bg-background p-3">
          <div className="mb-2 flex items-center justify-between">
            <h4 className="text-xs font-semibold text-text-primary">{t("settings.chain", { type })}</h4>
            {editing !== type && (
              <button onClick={() => startEdit(type)} className="text-xs text-agent hover:underline">{t("settings.edit")}</button>
            )}
          </div>
          {editing === type ? (
            <div>
              <input value={editValue} onChange={(e) => setEditValue(e.target.value)} className={inputClass} placeholder="provider1, provider2, …" />
              <div className="mt-2 flex gap-2">
                <SaveButton onClick={() => handleSave(type)} saving={saving} label={t("settings.saveChain")} />
                <button onClick={() => setEditing(null)} className="text-xs text-text-secondary hover:text-text-primary">{t("settings.cancelEdit")}</button>
              </div>
            </div>
          ) : (
            chains[type]?.length === 0 || !chains[type] ? (
              <p className="text-xs text-text-secondary">{t("settings.noProviders")}</p>
            ) : (
              <div className="flex items-center gap-2">
                {chains[type].map((p, i) => (
                  <div key={i} className="flex items-center gap-1">
                    <span className="rounded bg-agent/10 px-2 py-1 text-xs font-medium text-agent">{p}</span>
                    {i < chains[type].length - 1 && <span className="text-text-secondary">→</span>}
                  </div>
                ))}
              </div>
            )
          )}
        </div>
      ))}
    </div>
  );
}

// ─── 6. Integrations Tab ─────────────────────────────────────────────

function IntegrationsTab() {
  const { t } = useI18n();
  const [providers, setProviders] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const res = await authedRequest<any>(`${API_V1}/integrations/providers`);
      setProviders(res.providers ?? []);
    } catch { /* */ } finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  if (loading) return <p className="text-sm text-text-secondary">{t("settings.loadingIntegrations")}</p>;

  // Group by category
  const grouped = providers.reduce((acc: Record<string, any[]>, p: any) => {
    (acc[p.category] ??= []).push(p);
    return acc;
  }, {});

  return (
    <div>
      <SectionTitle title={t("settings.integrations")} description={t("settings.integrationsDesc")} />
      {Object.entries(grouped).map(([cat, provs]) => (
        <div key={cat} className="mb-4">
          <h4 className="mb-2 text-xs font-semibold uppercase text-text-secondary">{cat}</h4>
          <div className="grid grid-cols-2 gap-2">
            {provs.map((p: any, i: number) => (
              <div key={i} className="flex items-center justify-between rounded border border-border-soft bg-background p-2 text-xs">
                <span className="text-text-primary">{p.provider}</span>
                <span className={`rounded px-1.5 py-0.5 ${p.registered ? "bg-success/10 text-success" : "bg-text-secondary/10 text-text-secondary"}`}>
                  {p.registered ? t("settings.ready") : t("settings.notConfigured")}
                </span>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

// ─── 7. Personas Tab ─────────────────────────────────────────────────

function PersonasTab() {
  const { t } = useI18n();
  const [personas, setPersonas] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [department, setDepartment] = useState("");
  const [jobFamily, setJobFamily] = useState("");
  const [personaName, setPersonaName] = useState("");
  const [reqs, setReqs] = useState<{ field_path: string; operator: string; value: string; weight: number }[]>([
    { field_path: "", operator: "EQ", value: "", weight: 1 },
  ]);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await authedRequest<any>(`${API_V1}/personas`);
      setPersonas(res.personas ?? []);
    } catch { /* */ } finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  if (loading) return <p className="text-sm text-text-secondary">{t("settings.loadingPersonas")}</p>;

  async function handleCreate() {
    if (!department || !jobFamily || !personaName) return;
    const requirements = reqs.filter((r) => r.field_path).map((r) => ({
      field_path: r.field_path, operator: r.operator, value: r.value, weight: r.weight,
    }));
    if (requirements.length === 0) return;
    setSaving(true);
    try {
      await authedRequest(`${API_V1}/personas`, {
        method: "POST",
        body: JSON.stringify({ department, job_family: jobFamily, name: personaName, requirements }),
      });
      setShowForm(false);
      setDepartment(""); setJobFamily(""); setPersonaName("");
      setReqs([{ field_path: "", operator: "EQ", value: "", weight: 1 }]);
      await load();
    } catch { /* */ } finally { setSaving(false); }
  }

  async function handleDelete(id: string) {
    try {
      await authedRequest(`${API_V1}/personas/${id}`, { method: "DELETE" });
      await load();
    } catch { /* */ }
  }

  return (
    <div>
      <div className="mb-4 flex items-center justify-between">
        <SectionTitle title={t("settings.personas")} description={t("settings.personasDesc")} />
        <button onClick={() => setShowForm(!showForm)} className="rounded-md bg-agent px-3 py-1.5 text-xs font-semibold text-white">
          {showForm ? t("common.cancel") : t("settings.createPersona")}
        </button>
      </div>
      {showForm && (
        <div className="mb-4 rounded-lg border border-agent/30 bg-background p-3">
          <Field label={t("settings.department")}><input value={department} onChange={(e) => setDepartment(e.target.value)} className={inputClass} /></Field>
          <Field label={t("settings.jobFamily")}><input value={jobFamily} onChange={(e) => setJobFamily(e.target.value)} className={inputClass} /></Field>
          <Field label={t("settings.personaName")}><input value={personaName} onChange={(e) => setPersonaName(e.target.value)} className={inputClass} /></Field>
          <div className="mb-2">
            <label className="mb-1 block text-xs font-medium text-text-secondary">{t("settings.requirements")}</label>
            {reqs.map((r, i) => (
              <div key={i} className="mb-1 flex gap-1">
                <input value={r.field_path} onChange={(e) => { const n = [...reqs]; n[i].field_path = e.target.value; setReqs(n); }} className={inputClass} placeholder={t("settings.fieldPath")} />
                <select value={r.operator} onChange={(e) => { const n = [...reqs]; n[i].operator = e.target.value; setReqs(n); }} className={inputClass}>
                  {["EQ","NEQ","LT","LTE","GT","GTE","IN","NOT_IN","REGEX"].map((o) => <option key={o} value={o}>{o}</option>)}
                </select>
                <input value={r.value} onChange={(e) => { const n = [...reqs]; n[i].value = e.target.value; setReqs(n); }} className={inputClass} placeholder={t("settings.fieldValue")} />
                <input type="number" value={r.weight} onChange={(e) => { const n = [...reqs]; n[i].weight = Number(e.target.value); setReqs(n); }} className={`${inputClass} w-16`} />
              </div>
            ))}
            <button onClick={() => setReqs([...reqs, { field_path: "", operator: "EQ", value: "", weight: 1 }])} className="text-xs text-agent hover:underline">{t("settings.addField")}</button>
          </div>
          <SaveButton onClick={handleCreate} saving={saving} label={t("common.create")} />
        </div>
      )}
      {personas.length === 0 ? <EmptyState message={t("settings.noPersonasCreated")} /> : (
        <div className="space-y-2">
          {personas.map((p: any) => (
            <div key={p.persona_id} className="flex items-center justify-between rounded-lg border border-border-soft bg-background p-3">
              <div>
                <h4 className="text-sm font-medium text-text-primary">{p.name}</h4>
                <p className="text-xs text-text-secondary">{p.department} · {p.job_family}</p>
              </div>
              <button onClick={() => handleDelete(p.persona_id)} className="text-xs text-human hover:underline">{t("common.delete")}</button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── 8. KPI Tab ──────────────────────────────────────────────────────

function KpiTab() {
  const { t } = useI18n();
  const [kpis, setKpis] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [role, setRole] = useState("");
  const [kpiName, setKpiName] = useState("");
  const [cycle, setCycle] = useState("MONTHLY");
  const [terms, setTerms] = useState<{ metric_field: string; weight: number }[]>([{ metric_field: "", weight: 100 }]);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await authedRequest<any>(`${API_V1}/kpi/definitions`);
      setKpis(res.kpi_definitions ?? []);
    } catch { /* */ } finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  if (loading) return <p className="text-sm text-text-secondary">{t("settings.loadingKpis")}</p>;

  async function handleCreate() {
    if (!role || !kpiName) return;
    const formula = terms.filter((t) => t.metric_field).map((t) => ({ metric_field: t.metric_field, weight: t.weight }));
    if (formula.length === 0) return;
    if (formula.reduce((s, t) => s + t.weight, 0) !== 100) return;
    setSaving(true);
    try {
      await authedRequest(`${API_V1}/kpi/definitions`, {
        method: "POST",
        body: JSON.stringify({ role, name: kpiName, formula, cycle }),
      });
      setShowForm(false); setRole(""); setKpiName("");
      setTerms([{ metric_field: "", weight: 100 }]);
      await load();
    } catch { /* */ } finally { setSaving(false); }
  }

  async function handleDelete(id: string) {
    try {
      await authedRequest(`${API_V1}/kpi/definitions/${id}`, { method: "DELETE" });
      await load();
    } catch { /* */ }
  }

  return (
    <div>
      <div className="mb-4 flex items-center justify-between">
        <SectionTitle title={t("settings.kpi")} description={t("settings.kpiDesc")} />
        <button onClick={() => setShowForm(!showForm)} className="rounded-md bg-agent px-3 py-1.5 text-xs font-semibold text-white">
          {showForm ? t("common.cancel") : t("settings.createKpi")}
        </button>
      </div>
      {showForm && (
        <div className="mb-4 rounded-lg border border-agent/30 bg-background p-3">
          <Field label={t("settings.role")}><input value={role} onChange={(e) => setRole(e.target.value)} className={inputClass} /></Field>
          <Field label={t("settings.kpiName")}><input value={kpiName} onChange={(e) => setKpiName(e.target.value)} className={inputClass} /></Field>
          <Field label={t("settings.cycle")}>
            <select value={cycle} onChange={(e) => setCycle(e.target.value)} className={inputClass}>
              <option value="MONTHLY">Monthly</option><option value="QUARTERLY">Quarterly</option><option value="ANNUAL">Annual</option>
            </select>
          </Field>
          <div className="mb-2">
            <label className="mb-1 block text-xs font-medium text-text-secondary">{t("settings.formulaTerms")}</label>
            {terms.map((tm, i) => (
              <div key={i} className="mb-1 flex gap-2">
                <input value={tm.metric_field} onChange={(e) => { const n = [...terms]; n[i].metric_field = e.target.value; setTerms(n); }} className={inputClass} placeholder={t("settings.metricField")} />
                <input type="number" value={tm.weight} onChange={(e) => { const n = [...terms]; n[i].weight = Number(e.target.value); setTerms(n); }} className={`${inputClass} w-20`} placeholder={t("settings.termWeight")} />
              </div>
            ))}
            <button onClick={() => setTerms([...terms, { metric_field: "", weight: 0 }])} className="text-xs text-agent hover:underline">{t("settings.addTerm")}</button>
          </div>
          <SaveButton onClick={handleCreate} saving={saving} label={t("common.create")} />
        </div>
      )}
      {kpis.length === 0 ? <EmptyState message={t("settings.noKpisCreated")} /> : (
        <div className="space-y-2">
          {kpis.map((k: any) => (
            <div key={k.kpi_definition_id ?? k.id} className="flex items-center justify-between rounded border border-border-soft bg-background p-2 text-xs">
              <div>
                <span className="font-medium text-text-primary">{k.name}</span>
                <span className="ml-2 text-text-secondary">{t("settings.roleLabel")}: {k.role} · {k.cycle}</span>
              </div>
              <button onClick={() => handleDelete(k.kpi_definition_id)} className="text-xs text-human hover:underline">{t("common.delete")}</button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── 9. Onboarding Tab ───────────────────────────────────────────────

function OnboardingTab() {
  const { t } = useI18n();
  const [templates, setTemplates] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [tmplName, setTmplName] = useState("");
  const [items, setItems] = useState<{ item_code: string; label: string; category: string; assigned_role: string; default_due_days: number }[]>([
    { item_code: "", label: "", category: "", assigned_role: "", default_due_days: 7 },
  ]);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await authedRequest<any>(`${API_V1}/onboarding/templates`);
      setTemplates(res.templates ?? []);
    } catch { /* */ } finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  if (loading) return <p className="text-sm text-text-secondary">{t("settings.loadingTemplates")}</p>;

  async function handleCreate() {
    if (!tmplName) return;
    const checklist_items = items.filter((it) => it.item_code && it.label).map((it) => ({
      item_code: it.item_code, label: it.label, category: it.category || undefined,
      assigned_role: it.assigned_role || undefined, default_due_days: it.default_due_days,
    }));
    if (checklist_items.length === 0) return;
    setSaving(true);
    try {
      await authedRequest(`${API_V1}/onboarding/templates`, {
        method: "POST",
        body: JSON.stringify({ name: tmplName, checklist_items }),
      });
      setShowForm(false); setTmplName("");
      setItems([{ item_code: "", label: "", category: "", assigned_role: "", default_due_days: 7 }]);
      await load();
    } catch { /* */ } finally { setSaving(false); }
  }

  async function handleDelete(id: string) {
    try {
      await authedRequest(`${API_V1}/onboarding/templates/${id}`, { method: "DELETE" });
      await load();
    } catch { /* */ }
  }

  return (
    <div>
      <div className="mb-4 flex items-center justify-between">
        <SectionTitle title={t("settings.onboarding")} description={t("settings.onboardingDesc")} />
        <button onClick={() => setShowForm(!showForm)} className="rounded-md bg-agent px-3 py-1.5 text-xs font-semibold text-white">
          {showForm ? t("common.cancel") : t("settings.createTemplate")}
        </button>
      </div>
      {showForm && (
        <div className="mb-4 rounded-lg border border-agent/30 bg-background p-3">
          <Field label={t("settings.templateName")}><input value={tmplName} onChange={(e) => setTmplName(e.target.value)} className={inputClass} /></Field>
          <div className="mb-2">
            <label className="mb-1 block text-xs font-medium text-text-secondary">{t("settings.checklistItems")}</label>
            {items.map((it, i) => (
              <div key={i} className="mb-1 flex gap-1">
                <input value={it.item_code} onChange={(e) => { const n = [...items]; n[i].item_code = e.target.value; setItems(n); }} className={inputClass} placeholder={t("settings.itemCode")} />
                <input value={it.label} onChange={(e) => { const n = [...items]; n[i].label = e.target.value; setItems(n); }} className={inputClass} placeholder={t("settings.itemLabel")} />
                <input value={it.category} onChange={(e) => { const n = [...items]; n[i].category = e.target.value; setItems(n); }} className={inputClass} placeholder={t("settings.category")} />
                <input value={it.assigned_role} onChange={(e) => { const n = [...items]; n[i].assigned_role = e.target.value; setItems(n); }} className={inputClass} placeholder={t("settings.assigneeRole")} />
                <input type="number" value={it.default_due_days} onChange={(e) => { const n = [...items]; n[i].default_due_days = Number(e.target.value); setItems(n); }} className={`${inputClass} w-16`} placeholder={t("settings.dueDays")} />
              </div>
            ))}
            <button onClick={() => setItems([...items, { item_code: "", label: "", category: "", assigned_role: "", default_due_days: 7 }])} className="text-xs text-agent hover:underline">{t("settings.addItem")}</button>
          </div>
          <SaveButton onClick={handleCreate} saving={saving} label={t("common.create")} />
        </div>
      )}
      {templates.length === 0 ? <EmptyState message={t("settings.noTemplatesCreated")} /> : (
        <div className="space-y-2">
          {templates.map((tmpl: any) => (
            <div key={tmpl.template_id} className="flex items-center justify-between rounded border border-border-soft bg-background p-2 text-xs">
              <div>
                <span className="font-medium text-text-primary">{tmpl.name}</span>
                <span className="ml-2 text-text-secondary">{t("settings.steps", { count: tmpl.checklist_items?.length ?? 0 })}</span>
              </div>
              <button onClick={() => handleDelete(tmpl.template_id)} className="text-xs text-human hover:underline">{t("common.delete")}</button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── 10. Backup Tab ──────────────────────────────────────────────────

function BackupTab() {
  const { t } = useI18n();
  const [backups, setBackups] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [triggering, setTriggering] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await authedRequest<any>(`${API_V1}/settings/backup/list`);
      setBackups(res.backups ?? []);
    } catch { /* */ } finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  if (loading) return <p className="text-sm text-text-secondary">{t("settings.loadingBackups")}</p>;

  async function handleTrigger() {
    setTriggering(true);
    try {
      await authedRequest(`${API_V1}/settings/backup/trigger`, { method: "POST" });
      await load();
    } catch { /* */ } finally { setTriggering(false); }
  }

  return (
    <div>
      <div className="mb-4 flex items-center justify-between">
        <SectionTitle title={t("settings.backup")} description={t("settings.backupDesc")} />
        <button onClick={handleTrigger} disabled={triggering} className="rounded-md bg-agent px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50">
          {triggering ? t("settings.creating") : t("settings.triggerBackup")}
        </button>
      </div>
      {backups.length === 0 ? <EmptyState message={t("settings.noBackups")} /> : (
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-border-soft text-xs uppercase text-text-secondary">
              <th className="pb-2">{t("settings.filename")}</th><th className="pb-2">{t("settings.size")}</th><th className="pb-2">{t("settings.created")}</th><th className="pb-2 text-right">{t("settings.actions")}</th>
            </tr>
          </thead>
          <tbody>
            {backups.map((b: any) => (
              <tr key={b.filename} className="border-b border-border-soft last:border-0">
                <td className="py-2 font-mono text-xs text-text-primary">{b.filename}</td>
                <td className="py-2 text-xs text-text-secondary">{(b.size / 1024).toFixed(1)} KB</td>
                <td className="py-2 text-xs text-text-secondary">{new Date(b.created_at).toLocaleString()}</td>
                <td className="py-2 text-right">
                  <DownloadButton endpoint={`${API_V1}/settings/backup/download/${b.filename}`} format="tar" filename={b.filename} label={t("settings.download")} size="sm" />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

// ─── 11. Audit Tab ───────────────────────────────────────────────────

function AuditTab() {
  const { t } = useI18n();
  const [retention, setRetention] = useState<any>(null);
  const [days, setDays] = useState(90);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await authedRequest<any>(`${API_V1}/settings/audit/retention`);
      setRetention(res);
      setDays(res.retention_days);
    } catch { /* */ } finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  if (loading) return <p className="text-sm text-text-secondary">{t("settings.loading")}</p>;

  async function handleSave() {
    setSaving(true);
    try {
      await authedRequest(`${API_V1}/settings/audit/retention`, {
        method: "PATCH",
        body: JSON.stringify({ retention_days: days }),
      });
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch { /* */ } finally { setSaving(false); }
  }

  return (
    <div>
      <SectionTitle title={t("settings.auditRetention")} description={t("settings.auditDesc")} />

      <div className="mb-4 flex gap-2">
        <DownloadButton endpoint={`${API_V1}/audit-logs/export?format=csv`} format="csv" filename="audit-log.csv" label="Export CSV" size="sm" />
        <DownloadButton endpoint={`${API_V1}/audit-logs/export?format=json`} format="json" filename="audit-log.json" label="Export JSON" size="sm" />
      </div>
      <Field label={t("settings.retentionDays")}>
        <input type="number" value={days} onChange={(e) => setDays(Number(e.target.value))} className={inputClass} min={7} max={3650} />
      </Field>
      <Field label={t("settings.archiveAfter")}>
        <input value={retention?.archive_after_days ?? 30} disabled className={`${inputClass} opacity-50`} />
      </Field>
      <div className="flex items-center gap-3">
        <SaveButton onClick={handleSave} saving={saving} />
        {saved && <span className="text-xs text-success"><Icon icon={getIcon("Check")} size={12} tone="system" className="inline mr-1" />{t("settings.retentionUpdated")}</span>}
      </div>

      <div className="mt-6">
        <h4 className="mb-2 text-xs font-semibold text-text-primary">{t("settings.filterPreview")}</h4>
        <div className="flex gap-2">
          {[t("settings.last24h"), t("settings.last7d"), t("settings.last30d"), t("settings.all")].map((label) => (
            <button key={label} className="rounded border border-border-soft px-3 py-1.5 text-xs text-text-secondary hover:bg-background">
              {label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

// ─── 12. Data Export Tab ─────────────────────────────────────────────

function ExportTab() {
  const { t } = useI18n();
  const [exportJob, setExportJob] = useState<any>(null);
  const [requesting, setRequesting] = useState(false);

  async function handleRequest() {
    setRequesting(true);
    try {
      const res = await authedRequest<any>(`${API_V1}/settings/data-export/request`, { method: "POST" });
      setExportJob(res.export);
      // Poll for completion
      setTimeout(async () => {
        try {
          const status = await authedRequest<any>(`${API_V1}/settings/data-export/status/${res.export.id}`);
          setExportJob(status.export);
        } catch { /* */ }
      }, 6000);
    } catch { /* */ } finally { setRequesting(false); }
  }

  return (
    <div>
      <SectionTitle title={t("settings.dataExport")} description={t("settings.exportDesc")} />
      {!exportJob ? (
        <div>
          <p className="mb-3 text-xs text-text-secondary">{t("settings.exportHint")}</p>
          <button onClick={handleRequest} disabled={requesting} className="rounded-md bg-agent px-4 py-1.5 text-xs font-semibold text-white disabled:opacity-50">
            {requesting ? t("settings.requesting") : t("settings.requestExport")}
          </button>
        </div>
      ) : (
        <div className="rounded-lg border border-border-soft bg-background p-4">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium text-text-primary">{t("settings.exportNum", { id: exportJob.id })}</p>
              <p className="text-xs text-text-secondary">{t("settings.requested")} {new Date(exportJob.requested_at).toLocaleString()}</p>
            </div>
            <span className={`rounded px-2 py-1 text-xs font-medium ${
              exportJob.status === "READY" ? "bg-success/10 text-success" : "bg-attention/10 text-attention"
            }`}>
              {exportJob.status}
            </span>
          </div>
          {exportJob.status === "READY" && (
            <DownloadButton endpoint={`${API_V1}/settings/data-export/download/${exportJob.id}`} format="json" filename="data-export.json" label={t("settings.downloadExport")} size="sm" variant="primary" />
          )}
        </div>
      )}
    </div>
  );
}
