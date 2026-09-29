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

type SettingsTab = "profile" | "organization" | "users" | "credentials" | "fallback" |
  "integrations" | "personas" | "kpi" | "onboarding" | "backup" | "audit" | "export";

const TABS: { key: SettingsTab; label: string; icon: string }[] = [
  { key: "profile", label: "Profile", icon: "👤" },
  { key: "organization", label: "Organization", icon: "🏢" },
  { key: "users", label: "Users", icon: "👥" },
  { key: "credentials", label: "Credentials", icon: "🔑" },
  { key: "fallback", label: "Fallback Chains", icon: "🔗" },
  { key: "integrations", label: "Integrations", icon: "🔌" },
  { key: "personas", label: "Personas", icon: "🎭" },
  { key: "kpi", label: "KPI Templates", icon: "📊" },
  { key: "onboarding", label: "Onboarding", icon: "✅" },
  { key: "backup", label: "Backup", icon: "💾" },
  { key: "audit", label: "Audit & Retention", icon: "📋" },
  { key: "export", label: "Data Export", icon: "📦" },
];

export function Settings() {
  const [tab, setTab] = useState<SettingsTab>("profile");

  return (
    <div className="flex h-full gap-4">
      {/* Sidebar */}
      <nav className="w-48 flex-shrink-0 space-y-0.5 overflow-auto">
        {TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-xs font-medium transition-colors ${
              tab === t.key ? "bg-agent text-white" : "text-text-secondary hover:bg-background hover:text-text-primary"
            }`}
          >
            <span>{t.icon}</span>
            <span>{t.label}</span>
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

function SaveButton({ onClick, saving, label = "Save" }: { onClick: () => void; saving: boolean; label?: string }) {
  return (
    <button
      onClick={onClick}
      disabled={saving}
      className="rounded-md bg-agent px-4 py-1.5 text-xs font-semibold text-white disabled:opacity-50"
    >
      {saving ? "Saving…" : label}
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

// ─── 1. Profile Tab ──────────────────────────────────────────────────

function ProfileTab() {
  const [user, setUser] = useState<any>(null);
  const [sessions, setSessions] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

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

  if (loading) return <p className="text-sm text-text-secondary">Loading profile…</p>;
  if (!user) return <EmptyState message="Could not load profile." />;

  async function handleSave() {
    setSaving(true);
    try {
      await authedRequest(`${API_V1}/settings/me/profile`, {
        method: "PATCH",
        body: JSON.stringify({ full_name: name, phone }),
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
      <SectionTitle title="Profile" description="Your personal information and active sessions" />
      <Field label="Full Name">
        <input value={name} onChange={(e) => setName(e.target.value)} className={inputClass} />
      </Field>
      <Field label="Email">
        <input value={user.email} disabled className={`${inputClass} opacity-50`} />
      </Field>
      <Field label="Phone">
        <input value={phone} onChange={(e) => setPhone(e.target.value)} className={inputClass} placeholder="+880…" />
      </Field>
      <Field label="Role">
        <input value={user.role} disabled className={`${inputClass} opacity-50`} />
      </Field>
      <div className="flex items-center gap-3">
        <SaveButton onClick={handleSave} saving={saving} />
        {saved && <span className="text-xs text-success">✓ Saved</span>}
      </div>

      {/* Sessions */}
      <div className="mt-6">
        <h4 className="mb-2 text-xs font-semibold text-text-primary">Active Sessions</h4>
        {sessions.length === 0 ? (
          <EmptyState message="No active sessions." />
        ) : (
          <div className="space-y-1">
            {sessions.map((s: any) => (
              <div key={s.session_id} className="flex items-center justify-between rounded bg-background p-2 text-xs">
                <div>
                  <span className={s.current ? "font-semibold text-agent" : "text-text-primary"}>
                    {s.current ? "Current session" : s.session_id.slice(0, 12) + "…"}
                  </span>
                  <span className="ml-2 text-text-secondary">{s.ip} · {new Date(s.created_at).toLocaleDateString()}</span>
                </div>
                {!s.current && (
                  <button onClick={() => handleRevoke(s.session_id)} className="text-human hover:underline">Revoke</button>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── 2. Organization Tab ─────────────────────────────────────────────

function OrganizationTab() {
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

  if (loading) return <p className="text-sm text-text-secondary">Loading…</p>;
  if (!org) return <EmptyState message="Could not load organization." />;

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
      <SectionTitle title="Organization" description="Organization profile and configuration (ADMIN only)" />
      <Field label="Organization Name">
        <input value={name} onChange={(e) => setName(e.target.value)} className={inputClass} />
      </Field>
      <Field label="Sector">
        <select value={sector} onChange={(e) => setSector(e.target.value)} className={inputClass}>
          <option value="GOVT_NONCADRE">Govt (Non-Cadre)</option>
          <option value="BCS">BCS</option>
          <option value="STATE_BANK">State Bank</option>
          <option value="PRIVATE_BANK">Private Bank</option>
          <option value="CORPORATE">Corporate</option>
          <option value="NGO">NGO</option>
          <option value="SME">SME</option>
        </select>
      </Field>
      <Field label="Deployment Mode">
        <input value={org.deployment_mode ?? "CLOUD"} disabled className={`${inputClass} opacity-50`} />
      </Field>
      <Field label="Default Language">
        <input value={org.default_language ?? "en"} disabled className={`${inputClass} opacity-50`} />
      </Field>
      <div className="flex items-center gap-3">
        <SaveButton onClick={handleSave} saving={saving} />
        {saved && <span className="text-xs text-success">✓ Saved</span>}
      </div>
    </div>
  );
}

// ─── 3. Users Tab ────────────────────────────────────────────────────

function UsersTab() {
  const [users, setUsers] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [showInvite, setShowInvite] = useState(false);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteName, setInviteName] = useState("");
  const [inviteRole, setInviteRole] = useState("RECRUITER");

  const load = useCallback(async () => {
    try {
      const res = await authedRequest<any>(`${API_V1}/settings`);
      setUsers(res.users ?? []);
    } catch { /* */ } finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  if (loading) return <p className="text-sm text-text-secondary">Loading users…</p>;

  async function handleInvite() {
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
        <SectionTitle title="Users" description="Manage staff accounts (ADMIN only)" />
        <button onClick={() => setShowInvite(!showInvite)} className="rounded-md bg-agent px-3 py-1.5 text-xs font-semibold text-white">
          {showInvite ? "Cancel" : "+ Invite User"}
        </button>
      </div>

      {showInvite && (
        <div className="mb-4 rounded-lg border border-agent/30 bg-background p-3">
          <Field label="Email"><input value={inviteEmail} onChange={(e) => setInviteEmail(e.target.value)} className={inputClass} type="email" /></Field>
          <Field label="Full Name"><input value={inviteName} onChange={(e) => setInviteName(e.target.value)} className={inputClass} /></Field>
          <Field label="Role">
            <select value={inviteRole} onChange={(e) => setInviteRole(e.target.value)} className={inputClass}>
              <option value="ADMIN">Admin</option>
              <option value="SENIOR_RECRUITER">Senior Recruiter</option>
              <option value="RECRUITER">Recruiter</option>
              <option value="AUDITOR">Auditor</option>
              <option value="DEPT_HEAD">Department Head</option>
            </select>
          </Field>
          <SaveButton onClick={handleInvite} saving={false} label="Send Invite" />
        </div>
      )}

      {users.length === 0 ? <EmptyState message="No users found." /> : (
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-border-soft text-xs uppercase text-text-secondary">
              <th className="pb-2">Name</th><th className="pb-2">Email</th><th className="pb-2">Role</th><th className="pb-2">Status</th><th className="pb-2 text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {users.map((u: any) => (
              <tr key={u.user_id} className="border-b border-border-soft last:border-0">
                <td className="py-2 text-text-primary">{u.full_name}</td>
                <td className="py-2 text-text-secondary">{u.email}</td>
                <td className="py-2"><span className="rounded bg-agent/10 px-1.5 py-0.5 text-xs text-agent">{u.role}</span></td>
                <td className="py-2"><span className={`rounded px-1.5 py-0.5 text-xs ${u.active !== false ? "bg-success/10 text-success" : "bg-human/10 text-human"}`}>{u.active !== false ? "Active" : "Inactive"}</span></td>
                <td className="py-2 text-right">
                  <button onClick={() => handleDeactivate(u.user_id)} className="text-xs text-human hover:underline">Deactivate</button>
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
  const [creds, setCreds] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const res = await authedRequest<any>(`${API_V1}/credentials`);
      setCreds(res.credentials ?? []);
    } catch { /* */ } finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  if (loading) return <p className="text-sm text-text-secondary">Loading credentials…</p>;

  return (
    <div>
      <SectionTitle title="BYOK Credentials" description="Encrypted API keys for integrations (ADMIN only)" />
      {creds.length === 0 ? <EmptyState message="No credentials configured. Add connector keys to enable integrations." /> : (
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-border-soft text-xs uppercase text-text-secondary">
              <th className="pb-2">Connector</th><th className="pb-2">Label</th><th className="pb-2">Key Hint</th><th className="pb-2">Status</th><th className="pb-2">Created</th>
            </tr>
          </thead>
          <tbody>
            {creds.map((c: any) => (
              <tr key={c.credential_id} className="border-b border-border-soft last:border-0">
                <td className="py-2 font-mono text-xs text-text-primary">{c.connector}</td>
                <td className="py-2 text-text-secondary">{c.label}</td>
                <td className="py-2 font-mono text-xs text-text-secondary">{c.key_hint ?? "••••"}</td>
                <td className="py-2"><span className={`rounded px-1.5 py-0.5 text-xs ${c.active !== false ? "bg-success/10 text-success" : "bg-human/10 text-human"}`}>{c.active !== false ? "Active" : "Revoked"}</span></td>
                <td className="py-2 text-xs text-text-secondary">{new Date(c.created_at).toLocaleDateString()}</td>
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
  const [chains, setChains] = useState<Record<string, string[]>>({});
  const [loading, setLoading] = useState(true);

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

  if (loading) return <p className="text-sm text-text-secondary">Loading fallback chains…</p>;

  return (
    <div>
      <SectionTitle title="Fallback Chains" description="Ordered provider lists for each message type (ADMIN only)" />
      {(["SMS", "EMAIL", "WHATSAPP"] as const).map((type) => (
        <div key={type} className="mb-4 rounded-lg border border-border-soft bg-background p-3">
          <h4 className="mb-2 text-xs font-semibold text-text-primary">{type} Chain</h4>
          {chains[type]?.length === 0 || !chains[type] ? (
            <p className="text-xs text-text-secondary">No providers configured. Add credentials first.</p>
          ) : (
            <div className="flex items-center gap-2">
              {chains[type].map((p, i) => (
                <div key={i} className="flex items-center gap-1">
                  <span className="rounded bg-agent/10 px-2 py-1 text-xs font-medium text-agent">{p}</span>
                  {i < chains[type].length - 1 && <span className="text-text-secondary">→</span>}
                </div>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

// ─── 6. Integrations Tab ─────────────────────────────────────────────

function IntegrationsTab() {
  const [providers, setProviders] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const res = await authedRequest<any>(`${API_V1}/integrations/providers`);
      setProviders(res.providers ?? []);
    } catch { /* */ } finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  if (loading) return <p className="text-sm text-text-secondary">Loading integrations…</p>;

  // Group by category
  const grouped = providers.reduce((acc: Record<string, any[]>, p: any) => {
    (acc[p.category] ??= []).push(p);
    return acc;
  }, {});

  return (
    <div>
      <SectionTitle title="Integrations" description="Provider registry and adapter status" />
      {Object.entries(grouped).map(([cat, provs]) => (
        <div key={cat} className="mb-4">
          <h4 className="mb-2 text-xs font-semibold uppercase text-text-secondary">{cat}</h4>
          <div className="grid grid-cols-2 gap-2">
            {provs.map((p: any, i: number) => (
              <div key={i} className="flex items-center justify-between rounded border border-border-soft bg-background p-2 text-xs">
                <span className="text-text-primary">{p.provider}</span>
                <span className={`rounded px-1.5 py-0.5 ${p.registered ? "bg-success/10 text-success" : "bg-text-secondary/10 text-text-secondary"}`}>
                  {p.registered ? "Ready" : "Not configured"}
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
  const [personas, setPersonas] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const res = await authedRequest<any>(`${API_V1}/personas`);
      setPersonas(res.personas ?? []);
    } catch { /* */ } finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  if (loading) return <p className="text-sm text-text-secondary">Loading personas…</p>;

  return (
    <div>
      <SectionTitle title="Departmental Personas" description="Define department requirements for 7-dimension matching" />
      {personas.length === 0 ? <EmptyState message="No personas defined. Create personas to configure department-specific requirements." /> : (
        <div className="space-y-2">
          {personas.map((p: any) => (
            <div key={p.persona_id} className="rounded-lg border border-border-soft bg-background p-3">
              <h4 className="text-sm font-medium text-text-primary">{p.name}</h4>
              <p className="text-xs text-text-secondary">{p.department ?? "General"}</p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── 8. KPI Tab ──────────────────────────────────────────────────────

function KpiTab() {
  const [kpis, setKpis] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const res = await authedRequest<any>(`${API_V1}/kpi/definitions`);
      setKpis(res.definitions ?? res.kpis ?? []);
    } catch { /* */ } finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  if (loading) return <p className="text-sm text-text-secondary">Loading KPI definitions…</p>;

  return (
    <div>
      <SectionTitle title="KPI Templates" description="Key performance indicators per role" />
      {kpis.length === 0 ? <EmptyState message="No KPI definitions configured." /> : (
        <div className="space-y-2">
          {kpis.map((k: any) => (
            <div key={k.kpi_definition_id ?? k.id} className="rounded border border-border-soft bg-background p-2 text-xs">
              <span className="font-medium text-text-primary">{k.name ?? k.kpi_name}</span>
              <span className="ml-2 text-text-secondary">Role: {k.role} · Weight: {k.weight ?? 1}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── 9. Onboarding Tab ───────────────────────────────────────────────

function OnboardingTab() {
  const [templates, setTemplates] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const res = await authedRequest<any>(`${API_V1}/onboarding/templates`);
      setTemplates(res.templates ?? []);
    } catch { /* */ } finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  if (loading) return <p className="text-sm text-text-secondary">Loading templates…</p>;

  return (
    <div>
      <SectionTitle title="Onboarding Templates" description="Checklist templates per role" />
      {templates.length === 0 ? <EmptyState message="No onboarding templates. Create templates to standardize the onboarding process." /> : (
        <div className="space-y-2">
          {templates.map((t: any) => (
            <div key={t.template_id} className="rounded border border-border-soft bg-background p-2 text-xs">
              <span className="font-medium text-text-primary">{t.role}</span>
              <span className="ml-2 text-text-secondary">{t.steps?.length ?? 0} steps</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── 10. Backup Tab ──────────────────────────────────────────────────

function BackupTab() {
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

  if (loading) return <p className="text-sm text-text-secondary">Loading backups…</p>;

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
        <SectionTitle title="Backup" description="Trigger and download backup archives (ADMIN only)" />
        <button onClick={handleTrigger} disabled={triggering} className="rounded-md bg-agent px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50">
          {triggering ? "Creating…" : "Trigger Backup"}
        </button>
      </div>
      {backups.length === 0 ? <EmptyState message="No backups yet. Trigger a backup to create an archive." /> : (
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-border-soft text-xs uppercase text-text-secondary">
              <th className="pb-2">Filename</th><th className="pb-2">Size</th><th className="pb-2">Created</th><th className="pb-2 text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {backups.map((b: any) => (
              <tr key={b.filename} className="border-b border-border-soft last:border-0">
                <td className="py-2 font-mono text-xs text-text-primary">{b.filename}</td>
                <td className="py-2 text-xs text-text-secondary">{(b.size / 1024).toFixed(1)} KB</td>
                <td className="py-2 text-xs text-text-secondary">{new Date(b.created_at).toLocaleString()}</td>
                <td className="py-2 text-right">
                  <a href={`${API_V1}/settings/backup/download/${b.filename}`} className="text-xs text-agent hover:underline" target="_blank">Download</a>
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

  if (loading) return <p className="text-sm text-text-secondary">Loading…</p>;

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
      <SectionTitle title="Audit & Retention" description="Configure audit log retention and export trails" />
      <Field label="Retention (days)">
        <input type="number" value={days} onChange={(e) => setDays(Number(e.target.value))} className={inputClass} min={7} max={3650} />
      </Field>
      <Field label="Archive After (days)">
        <input value={retention?.archive_after_days ?? 30} disabled className={`${inputClass} opacity-50`} />
      </Field>
      <div className="flex items-center gap-3">
        <SaveButton onClick={handleSave} saving={saving} />
        {saved && <span className="text-xs text-success">✓ Retention updated</span>}
      </div>

      <div className="mt-6">
        <h4 className="mb-2 text-xs font-semibold text-text-primary">Filter Preview</h4>
        <div className="flex gap-2">
          {["Last 24h", "Last 7 days", "Last 30 days", "All"].map((label) => (
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
      <SectionTitle title="Data Export" description="Request a full organizational data export (ADMIN only, rate-limited)" />
      {!exportJob ? (
        <div>
          <p className="mb-3 text-xs text-text-secondary">This will export all candidates, rules, evaluations, audit logs, and documents as a ZIP archive.</p>
          <button onClick={handleRequest} disabled={requesting} className="rounded-md bg-agent px-4 py-1.5 text-xs font-semibold text-white disabled:opacity-50">
            {requesting ? "Requesting…" : "Request Export"}
          </button>
        </div>
      ) : (
        <div className="rounded-lg border border-border-soft bg-background p-4">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium text-text-primary">Export #{exportJob.id}</p>
              <p className="text-xs text-text-secondary">Requested {new Date(exportJob.requested_at).toLocaleString()}</p>
            </div>
            <span className={`rounded px-2 py-1 text-xs font-medium ${
              exportJob.status === "READY" ? "bg-success/10 text-success" : "bg-attention/10 text-attention"
            }`}>
              {exportJob.status}
            </span>
          </div>
          {exportJob.status === "READY" && (
            <button className="mt-3 rounded-md bg-agent px-4 py-1.5 text-xs font-semibold text-white">Download ZIP</button>
          )}
        </div>
      )}
    </div>
  );
}
