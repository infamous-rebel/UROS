/**
 * ForgotPasswordScreen — Quest 05 Part 1c. The backend answers
 * generically (anti-enumeration), so the confirmation must never hint
 * whether the email exists (Decision Lock 1).
 */
import { useState } from "react";
import { requestPasswordReset } from "../../api/auth";
import { useI18n } from "../../i18n";

export function ForgotPasswordScreen() {
  const { t } = useI18n();
  const [email, setEmail] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [sent, setSent] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!email.trim() || submitting) return;
    setSubmitting(true);
    try {
      await requestPasswordReset(email.trim());
      setSent(true);
    } catch {
      // Network/unknown failure — stay on the form; the generic message
      // is only shown after an accepted request.
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="w-full max-w-sm rounded-lg border border-border-soft bg-surface p-6">
      <h1 className="text-lg font-semibold text-text-primary">{t("auth.forgotTitle")}</h1>
      <p className="mt-1 text-sm text-text-secondary">{t("auth.forgotSubtitle")}</p>

      {sent ? (
        <>
          <p className="mt-4 rounded-md border border-success/30 bg-success/10 px-3 py-2 text-xs text-success">
            {t("auth.resetRequestSent")}
          </p>
          <a href="/" className="mt-4 block text-center text-xs text-text-secondary hover:text-text-primary">
            {t("auth.backToSignIn")}
          </a>
        </>
      ) : (
        <>
          <label className="mt-5 block text-xs font-medium text-text-secondary" htmlFor="forgot-email">
            {t("auth.emailLabel")}
          </label>
          <input
            id="forgot-email"
            type="email"
            autoComplete="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="mt-1 w-full rounded-md border border-border-soft bg-background px-3 py-2 text-sm text-text-primary focus:border-agent focus:outline-none"
          />
          <button
            type="submit"
            disabled={submitting}
            className="mt-4 w-full rounded-md bg-agent px-3 py-2 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
          >
            {submitting ? t("auth.sending") : t("auth.sendResetLink")}
          </button>
          <a href="/" className="mt-3 block text-center text-xs text-text-secondary hover:text-text-primary">
            {t("auth.backToSignIn")}
          </a>
        </>
      )}
    </form>
  );
}
