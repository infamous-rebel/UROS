/**
 * LoginScreen — Quest 05 Part 1c (Decision Lock 1: no temp passwords, no
 * bypass — sign-in is email + password, full stop). PASSWORD_RESET_REQUIRED
 * is surfaced as one actionable instruction instead of a dead end.
 */
import { useState } from "react";
import { ApiError } from "../../api/client";
import { useAuth } from "../../auth/AuthContext";
import { useI18n } from "../../i18n";
import { PlainError } from "../PlainError";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function LoginScreen() {
  const { signIn } = useAuth();
  const { t } = useI18n();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [remember, setRemember] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const [touched, setTouched] = useState<{ email?: boolean; password?: boolean }>({});

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setTouched({ email: true, password: true });
    if (!email.trim() || !password || submitting) return;
    setSubmitting(true);
    setErrorCode(null);
    try {
      await signIn(email.trim(), password, remember);
      // On success the AuthProvider flips the app to the dashboard.
    } catch (err) {
      setErrorCode(err instanceof ApiError ? err.errorCode ?? "NETWORK" : "NETWORK");
    } finally {
      setSubmitting(false);
    }
  }

  const errorMessage =
    errorCode === "PASSWORD_RESET_REQUIRED"
      ? t("auth.errorResetRequired")
      : errorCode === "INVALID_CREDENTIALS"
        ? t("auth.errorInvalidCredentials")
        : errorCode
          ? t("auth.errorNetwork")
          : null;

  return (
    <form onSubmit={onSubmit} className="w-full max-w-sm rounded-lg border border-border-soft bg-surface p-6">
      <h1 className="text-lg font-semibold text-text-primary">{t("auth.signInTitle")}</h1>
      <p className="mt-1 text-sm text-text-secondary">{t("auth.signInSubtitle")}</p>

      <label className="mt-5 block text-xs font-medium text-text-secondary" htmlFor="login-email">
        {t("auth.emailLabel")}
      </label>
      <input
        id="login-email"
        type="email"
        autoComplete="email"
        required
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        onBlur={() => setTouched((t) => ({ ...t, email: true }))}
        className={`mt-1 w-full rounded-md border ${touched.email && (!email.trim() || !EMAIL_RE.test(email)) ? "border-danger" : "border-border-soft"} bg-background px-3 py-2 text-sm text-text-primary focus:border-agent focus:outline-none`}
      />
      {touched.email && !email.trim() && (
        <p className="mt-1 text-xs text-danger">This field is required.</p>
      )}
      {touched.email && email.trim() && !EMAIL_RE.test(email) && (
        <p className="mt-1 text-xs text-danger">Must be a valid email address.</p>
      )}

      <label className="mt-3 block text-xs font-medium text-text-secondary" htmlFor="login-password">
        {t("auth.passwordLabel")}
      </label>
      <input
        id="login-password"
        type="password"
        autoComplete="current-password"
        required
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        onBlur={() => setTouched((t) => ({ ...t, password: true }))}
        className={`mt-1 w-full rounded-md border ${touched.password && !password ? "border-danger" : "border-border-soft"} bg-background px-3 py-2 text-sm text-text-primary focus:border-agent focus:outline-none`}
      />
      {touched.password && !password && (
        <p className="mt-1 text-xs text-danger">This field is required.</p>
      )}

      <label className="mt-3 flex items-center gap-2 text-xs text-text-secondary">
        <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} className="accent-agent" />
        {t("auth.rememberMe")}
      </label>

      {errorMessage && (
        <div role="alert" className="mt-3">
          <PlainError status={errorCode === "PASSWORD_RESET_REQUIRED" ? 403 : errorCode === "INVALID_CREDENTIALS" ? 401 : 503} message={errorMessage} />
        </div>
      )}

      <button
        type="submit"
        disabled={submitting}
        className="mt-4 w-full rounded-md bg-agent px-3 py-2 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
      >
        {submitting ? t("auth.signingIn") : t("auth.signIn")}
      </button>

      <a href="#/forgot" className="mt-3 block text-center text-xs text-text-secondary hover:text-text-primary">
        {t("auth.forgotLink")}
      </a>
    </form>
  );
}
