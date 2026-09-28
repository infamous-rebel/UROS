import { useState } from "react";
import {
  useRequestOtp,
  useVerifyOtp,
  useApplicantStatus,
  useSubmitAppeal,
  getApplicantToken,
  clearApplicantToken,
  setApplicantPreferredLanguage,
  ApplicantReasonEntry,
} from "../hooks/hooks_applicant_portal";
import { I18nProvider, useI18n, SupportedLanguage } from "../i18n";
import { LanguageSwitcher } from "./LanguageSwitcher";

const PILL_COLOR: Record<string, string> = {
  green: "bg-success text-white",
  amber: "bg-attention text-white",
  red: "bg-danger text-white",
  neutral: "bg-border-soft text-text-secondary",
};

function StatusPill({ label, tone }: { label: string; tone: string }) {
  return <span className={`rounded-full px-3 py-1 text-xs font-medium ${PILL_COLOR[tone] ?? PILL_COLOR.neutral}`}>{label}</span>;
}

/** "Why?" — Global Reasoning Standard: every result panel carries a link to its reason_code + reason_description + evidence. */
function WhyLink({ reasonCode, reasonDescription, evidenceRows }: { reasonCode: string; reasonDescription: string; evidenceRows?: Array<[string, string]> }) {
  const [open, setOpen] = useState(false);
  const { t } = useI18n();
  return (
    <div>
      <button onClick={() => setOpen((o) => !o)} className="text-xs text-agent underline">
        {t("portal.why")} {open ? "▲" : "▼"}
      </button>
      {open && (
        <div className="mt-2 rounded-md border border-border-soft bg-background p-3 text-xs">
          <div className="mb-1">
            <span className="font-mono text-text-secondary">{t("portal.reasonCodeLabel")}</span> <span className="text-text-primary">{reasonCode}</span>
          </div>
          <div className="text-text-secondary">{reasonDescription}</div>
          {evidenceRows && evidenceRows.length > 0 && (
            <table className="mt-2 w-full text-left">
              <tbody>
                {evidenceRows.map(([k, v]) => (
                  <tr key={k} className="border-t border-border-soft">
                    <td className="py-1 pr-2 text-text-secondary">{k}</td>
                    <td className="py-1 text-text-primary">{v}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  );
}

function ReasonCard({ reason }: { reason: ApplicantReasonEntry }) {
  const statusTone = reason.status === "FAIL" ? "red" : reason.status === "NEEDS_REVIEW" ? "amber" : "green";
  const { t } = useI18n();
  return (
    <div className="rounded-lg border border-border-soft bg-surface p-3">
      <div className="mb-1 flex items-center justify-between">
        <span className="text-sm font-medium text-text-primary">{reason.evidence.field_path}</span>
        <StatusPill label={reason.status.replace("_", " ")} tone={statusTone} />
      </div>
      <WhyLink
        reasonCode={reason.reason_code}
        reasonDescription={reason.reason_description}
        evidenceRows={[
          [t("portal.ruleApplied"), reason.evidence.rule_applied],
          [t("portal.yourSubmittedValue"), reason.evidence.extracted_value === null || reason.evidence.extracted_value === undefined ? "—" : String(reason.evidence.extracted_value)],
          [t("portal.confidence"), reason.evidence.confidence === null ? "—" : String(reason.evidence.confidence)],
          [t("portal.evaluatedAt"), new Date(reason.evaluated_at).toLocaleString()],
        ]}
      />
    </div>
  );
}

function LoginScreen() {
  const [step, setStep] = useState<"request" | "verify">("request");
  const [candidateId, setCandidateId] = useState("");
  const [channel, setChannel] = useState<"EMAIL" | "SMS">("EMAIL");
  const [code, setCode] = useState("");
  const requestOtp = useRequestOtp();
  const verifyOtp = useVerifyOtp();
  const { t } = useI18n();

  return (
    <div className="mx-auto mt-16 w-full max-w-sm rounded-lg border border-border-soft bg-surface p-6">
      <div className="mb-3 flex justify-end">
        <LanguageSwitcher />
      </div>
      <h1 className="mb-1 text-lg font-semibold text-text-primary">{t("portal.title")}</h1>
      <p className="mb-4 text-xs text-text-secondary">{t("portal.subtitle")}</p>

      {step === "request" && (
        <div className="flex flex-col gap-3">
          <input
            value={candidateId}
            onChange={(e) => setCandidateId(e.target.value)}
            placeholder={t("portal.candidateIdPlaceholder")}
            className="rounded-md border border-border-soft bg-background px-3 py-2 text-sm text-text-primary"
          />
          <div className="flex gap-2 text-xs">
            <label className="flex items-center gap-1">
              <input type="radio" checked={channel === "EMAIL"} onChange={() => setChannel("EMAIL")} /> {t("portal.channelEmail")}
            </label>
            <label className="flex items-center gap-1">
              <input type="radio" checked={channel === "SMS"} onChange={() => setChannel("SMS")} /> {t("portal.channelSms")}
            </label>
          </div>
          <button
            disabled={!candidateId.trim() || requestOtp.isPending}
            onClick={() =>
              requestOtp.mutate(
                { candidateId: candidateId.trim(), channel },
                { onSuccess: () => setStep("verify") }
              )
            }
            className="rounded-md bg-agent px-3 py-2 text-sm font-medium text-white disabled:opacity-50"
          >
            {requestOtp.isPending ? t("portal.sending") : t("portal.sendCode")}
          </button>
        </div>
      )}

      {step === "verify" && (
        <div className="flex flex-col gap-3">
          <p className="text-xs text-text-secondary">
            {t("portal.codeSentNotice", { channel: channel.toLowerCase(), candidateId })}
          </p>
          <input
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
            placeholder={t("portal.codePlaceholder")}
            className="rounded-md border border-border-soft bg-background px-3 py-2 text-sm tracking-widest text-text-primary"
          />
          {verifyOtp.isError && <div className="text-xs text-danger">{(verifyOtp.error as Error).message}</div>}
          <button
            disabled={code.length !== 6 || verifyOtp.isPending}
            onClick={() => verifyOtp.mutate({ candidateId: candidateId.trim(), code })}
            className="rounded-md bg-human px-3 py-2 text-sm font-medium text-white disabled:opacity-50"
          >
            {verifyOtp.isPending ? t("portal.verifying") : t("portal.verifyAndView")}
          </button>
          <button onClick={() => setStep("request")} className="text-xs text-text-secondary underline">
            {t("portal.useDifferentId")}
          </button>
        </div>
      )}
    </div>
  );
}

function AppealForm({ candidateId, onDone }: { candidateId: string; onDone: () => void }) {
  const [category, setCategory] = useState("Data Error");
  const [reasonText, setReasonText] = useState("");
  const submit = useSubmitAppeal();
  const { t } = useI18n();

  if (submit.isSuccess) {
    return (
      <div className="rounded-md border border-success bg-background p-3 text-xs text-success">
        {t("portal.appealSubmittedNotice", { appealId: submit.data.appeal_id.slice(0, 8) })}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2 rounded-md border border-border-soft bg-background p-3">
      {/* option `value`s are stable English category codes the backend's appeal
          triage expects (see 20-29_Supplementary_Modules.md §1.4) — only the
          visible label is translated, so a Bangla-UI submission still sends
          the same category the backend understands. */}
      <select value={category} onChange={(e) => setCategory(e.target.value)} className="rounded border border-border-soft bg-surface px-2 py-1.5 text-xs">
        <option value="Data Error">{t("portal.appealCategoryDataError")}</option>
        <option value="Rule Misapplication">{t("portal.appealCategoryRuleMisapplication")}</option>
        <option value="Document Update">{t("portal.appealCategoryDocumentUpdate")}</option>
        <option value="Quota Dispute">{t("portal.appealCategoryQuotaDispute")}</option>
      </select>
      <textarea
        value={reasonText}
        onChange={(e) => setReasonText(e.target.value)}
        placeholder={t("portal.appealReasonPlaceholder")}
        rows={3}
        className="rounded border border-border-soft bg-surface px-2 py-1.5 text-xs"
      />
      {submit.isError && <div className="text-xs text-danger">{(submit.error as Error).message}</div>}
      <div className="flex gap-2">
        <button
          disabled={!reasonText.trim() || submit.isPending}
          onClick={() => submit.mutate({ candidateId, reasonText: reasonText.trim(), category })}
          className="rounded bg-human px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50"
        >
          {submit.isPending ? t("portal.submitting") : t("portal.submitAppeal")}
        </button>
        <button onClick={onDone} className="text-xs text-text-secondary">
          {t("portal.cancel")}
        </button>
      </div>
    </div>
  );
}

function StatusScreen() {
  const { data, isLoading, isError, error } = useApplicantStatus();
  const [showAppeal, setShowAppeal] = useState(false);
  const { t } = useI18n();

  if (isLoading) {
    return <div className="mx-auto mt-16 max-w-lg text-center text-sm text-text-secondary">{t("portal.loading")}</div>;
  }
  if (isError) {
    return (
      <div className="mx-auto mt-16 max-w-lg rounded-lg border border-danger bg-surface p-4 text-center text-sm text-danger">
        {(error as Error).message || t("portal.loadFailedFallback")}
        <div className="mt-3">
          <button onClick={() => clearApplicantToken()} className="text-xs text-agent underline">
            {t("portal.loginAgain")}
          </button>
        </div>
      </div>
    );
  }
  if (!data) return null;

  const view = data.status;

  return (
    <div className="mx-auto mt-8 flex w-full max-w-2xl flex-col gap-4 pb-16">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold text-text-primary">{view.full_name}</h1>
          <p className="text-xs text-text-secondary">
            {view.position_applied ?? "—"} {view.job_circular_id ? `· ${view.job_circular_id}` : ""} · {view.candidate_id}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <LanguageSwitcher onLanguageChange={(lang) => persistApplicantLanguage(lang)} />
          <button
            onClick={() => {
              clearApplicantToken();
              window.location.reload();
            }}
            className="text-xs text-text-secondary underline"
          >
            {t("portal.logOut")}
          </button>
        </div>
      </div>

      {/* Current stage — always visible, no dead space */}
      <div className="rounded-lg border border-border-soft bg-surface p-4">
        <div className="mb-2 flex items-center justify-between">
          <span className="text-xs uppercase tracking-wide text-text-secondary">{t("portal.currentStage")}</span>
          <StatusPill label={view.stage} tone={view.stage_pill} />
        </div>
        <WhyLink reasonCode={view.reason_code} reasonDescription={view.reason_description} />
      </div>

      {/* Reasons needing attention — every entry carries reason_code/description/evidence */}
      {view.reasons.length > 0 && (
        <div className="flex flex-col gap-2">
          <h2 className="text-sm font-medium text-text-primary">{t("portal.detailsHeading")}</h2>
          {view.reasons.map((r) => (
            <ReasonCard key={`${r.reason_code}-${r.evaluated_at}`} reason={r} />
          ))}
        </div>
      )}

      {/* Evidence summary: documents considered */}
      {view.evidence_documents.length > 0 && (
        <div className="rounded-lg border border-border-soft bg-surface p-4">
          <h2 className="mb-2 text-sm font-medium text-text-primary">{t("portal.documentsConsidered")}</h2>
          <div className="flex flex-col gap-1">
            {view.evidence_documents.map((d, i) => (
              <div key={i} className="flex items-center justify-between text-xs">
                <span className="text-text-secondary">{d.doc_type}</span>
                <span
                  className={
                    d.verification_status === "Verified"
                      ? "text-success"
                      : d.verification_status === "Failed"
                      ? "text-danger"
                      : "text-attention"
                  }
                >
                  {d.verification_status}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Timeline / next update — never a dead end */}
      <div className="rounded-lg border border-border-soft bg-background p-4 text-xs text-text-secondary">
        <div className="mb-1 font-medium text-text-primary">{t("portal.whatHappensNext")}</div>
        <div>{view.next_expected_update}</div>
        <div className="mt-1">{view.estimated_timeline_text}</div>
      </div>

      {/* Appeal — configurable per org, wired to the existing appeals endpoint */}
      {view.appeal_enabled && (
        <div>
          {!showAppeal ? (
            <button onClick={() => setShowAppeal(true)} className="rounded-md border border-human px-3 py-1.5 text-xs font-medium text-human">
              {t("portal.requestAppeal")}
            </button>
          ) : (
            <AppealForm candidateId={view.candidate_id} onDone={() => setShowAppeal(false)} />
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Feature 5: best-effort sync of the applicant's own language choice to
 * candidates.preferred_language (read by the Communication Hub's
 * template-language resolver — see
 * src/services/communication/template_language_resolver.ts). Only fires
 * once the applicant has an active session; a failed PATCH never blocks
 * or reverts the local UI language change, which already applied.
 */
function persistApplicantLanguage(lang: SupportedLanguage): void {
  if (!getApplicantToken()) return;
  setApplicantPreferredLanguage(lang).catch(() => {
    // Non-fatal: the person's session-local language choice still applies.
  });
}

function ApplicantStatusPortalContent() {
  const authenticated = !!getApplicantToken();

  return (
    <div className="min-h-screen bg-background px-4 py-8">
      {authenticated ? <StatusScreen /> : <LoginScreen />}
    </div>
  );
}

/**
 * Standalone, public applicant-facing portal — deliberately separate
 * from the internal staff dashboard (`App.tsx`): no CommandBar, no
 * AuditStream, no staff dev-token dependency. Calm off-white design per
 * UROS_UI_UX_Direction.md's Applicant Status Portal section.
 *
 * Feature 5: wraps itself in its own <I18nProvider> (rather than relying
 * on an ancestor) so this component works correctly whether mounted
 * standalone (main.tsx routes /portal here directly) or under test —
 * no external provider wiring required.
 */
export function ApplicantStatusPortal() {
  return (
    <I18nProvider>
      <ApplicantStatusPortalContent />
    </I18nProvider>
  );
}
