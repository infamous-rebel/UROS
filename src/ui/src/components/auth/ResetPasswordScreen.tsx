/**
 * ResetPasswordScreen — Quest 05 Part 1c. The person lands here from the
 * one-time link (/reset-password?token=…). Lifecycle mirrors the backend:
 * verify (marks clicked) → confirm (consumes) → sign in. Expired/used
 * links get one plain-language instruction, never a dead form.
 */
import { useEffect, useState } from "react";
import { ApiError } from "../../api/client";
import { confirmPasswordReset, verifyResetToken } from "../../api/auth";
import { useI18n } from "../../i18n";

type Phase = "checking" | "invalid" | "ready" | "done";

export function ResetPasswordScreen() {
  const { t } = useI18n();
  const [phase, setPhase] = useState<Phase>("checking");
  const [token, setToken] = useState<string | null>(null);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [mismatch, setMismatch] = useState(false);
  const [policyError, setPolicyError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    const raw = new URLSearchParams(window.location.search).get("token") ?? "";
    if (!raw) {
      setPhase("invalid");
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const check = await verifyResetToken(raw);
        if (cancelled) return;
        setToken(raw);
        setPhase(check.valid && !check.expired ? "ready" : "invalid");
      } catch {
        if (!cancelled) setPhase("invalid");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!token || submitting) return;
    if (password !== confirm) {
      setMismatch(true);
      return;
    }
    setMismatch(false);
    setSubmitting(true);
    setPolicyError(null);
    try {
      await confirmPasswordReset(token, password);
      setPhase("done");
    } catch (err) {
      if (err instanceof ApiError) {
        // 422 PASSWORD_POLICY carries the human-readable rule text.
        setPolicyError(err.errorCode === "PASSWORD_POLICY" ? err.message : t("auth.resetInvalid"));
        if (err.errorCode === "RESET_TOKEN_INVALID") setPhase("invalid");
      } else {
        setPolicyError(t("auth.errorNetwork"));
      }
    } finally {
      setSubmitting(false);
    }
  }

  if (phase === "checking") {
    return <p className="text-sm text-text-secondary">{t("auth.resetChecking")}</p>;
  }

  if (phase === "invalid") {
    return (
      <div className="w-full max-w-sm rounded-lg border border-border-soft bg-surface p-6">
        <h1 className="text-lg font-semibold text-text-primary">{t("auth.resetTitle")}</h1>
        <p className="mt-4 rounded-md border border-danger/30 bg-danger/10 px-3 py-2 text-xs text-danger">
          {t("auth.resetInvalid")}
        </p>
        <a href="/" className="mt-4 block text-center text-xs text-text-secondary hover:text-text-primary">
          {t("auth.backToSignIn")}
        </a>
      </div>
    );
  }

  if (phase === "done") {
    return (
      <div className="w-full max-w-sm rounded-lg border border-border-soft bg-surface p-6">
        <h1 className="text-lg font-semibold text-text-primary">{t("auth.resetTitle")}</h1>
        <p className="mt-4 rounded-md border border-success/30 bg-success/10 px-3 py-2 text-xs text-success">
          {t("auth.resetDone")}
        </p>
        <a href="/" className="mt-4 block text-center text-xs text-text-secondary hover:text-text-primary">
          {t("auth.backToSignIn")}
        </a>
      </div>
    );
  }

  return (
    <form onSubmit={onSubmit} className="w-full max-w-sm rounded-lg border border-border-soft bg-surface p-6">
      <h1 className="text-lg font-semibold text-text-primary">{t("auth.resetTitle")}</h1>
      <p className="mt-1 text-xs text-text-secondary">{t("auth.passwordHint")}</p>

      <label className="mt-4 block text-xs font-medium text-text-secondary" htmlFor="reset-new">
        {t("auth.newPasswordLabel")}
      </label>
      <input
        id="reset-new"
        type="password"
        autoComplete="new-password"
        required
        minLength={10}
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        className="mt-1 w-full rounded-md border border-border-soft bg-background px-3 py-2 text-sm text-text-primary focus:border-agent focus:outline-none"
      />

      <label className="mt-3 block text-xs font-medium text-text-secondary" htmlFor="reset-confirm">
        {t("auth.confirmPasswordLabel")}
      </label>
      <input
        id="reset-confirm"
        type="password"
        autoComplete="new-password"
        required
        value={confirm}
        onChange={(e) => setConfirm(e.target.value)}
        className="mt-1 w-full rounded-md border border-border-soft bg-background px-3 py-2 text-sm text-text-primary focus:border-agent focus:outline-none"
      />

      {(mismatch || policyError) && (
        <p role="alert" className="mt-3 rounded-md border border-danger/30 bg-danger/10 px-3 py-2 text-xs text-danger">
          {mismatch ? t("auth.passwordMismatch") : policyError}
        </p>
      )}

      <button
        type="submit"
        disabled={submitting}
        className="mt-4 w-full rounded-md bg-agent px-3 py-2 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
      >
        {submitting ? t("auth.settingPassword") : t("auth.setPassword")}
      </button>
    </form>
  );
}
