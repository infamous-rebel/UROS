/**
 * ChangePasswordScreen — Quest 05 Part 1c (Decision Lock 1: every
 * password change is logged with timestamp, IP, user agent — the backend
 * does the logging; this screen explains the visible consequence:
 * other devices are signed out, this one stays).
 */
import { useState } from "react";
import { ApiError } from "../../api/client";
import { changePassword } from "../../api/auth";
import { useI18n } from "../../i18n";

export function ChangePasswordScreen() {
  const { t } = useI18n();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [mismatch, setMismatch] = useState(false);
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const [errorText, setErrorText] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (submitting) return;
    if (next !== confirm) {
      setMismatch(true);
      return;
    }
    setMismatch(false);
    setErrorCode(null);
    setErrorText(null);
    setSubmitting(true);
    try {
      await changePassword(current, next);
      setDone(true);
    } catch (err) {
      if (err instanceof ApiError) {
        setErrorCode(err.errorCode ?? "NETWORK");
        if (err.errorCode === "PASSWORD_POLICY") setErrorText(err.message);
      } else {
        setErrorCode("NETWORK");
      }
    } finally {
      setSubmitting(false);
    }
  }

  if (done) {
    return (
      <div className="max-w-md rounded-lg border border-border-soft bg-surface p-6">
        <h2 className="text-sm font-semibold text-text-primary">{t("auth.changePasswordTitle")}</h2>
        <p className="mt-3 rounded-md border border-success/30 bg-success/10 px-3 py-2 text-xs text-success">
          {t("auth.changePasswordDone")}
        </p>
      </div>
    );
  }

  const errorMessage =
    errorCode === "INVALID_CURRENT_PASSWORD"
      ? t("auth.errorWrongCurrent")
      : errorCode === "PASSWORD_POLICY"
        ? errorText
        : errorCode === "PASSWORD_RESET_REQUIRED"
          ? t("auth.errorResetRequired")
          : errorCode
            ? t("auth.errorNetwork")
            : null;

  return (
    <form onSubmit={onSubmit} className="max-w-md rounded-lg border border-border-soft bg-surface p-6">
      <h2 className="text-sm font-semibold text-text-primary">{t("auth.changePasswordTitle")}</h2>
      <p className="mt-1 text-xs text-text-secondary">{t("auth.passwordHint")}</p>

      <label className="mt-4 block text-xs font-medium text-text-secondary" htmlFor="pw-current">
        {t("auth.currentPasswordLabel")}
      </label>
      <input
        id="pw-current"
        type="password"
        autoComplete="current-password"
        required
        value={current}
        onChange={(e) => setCurrent(e.target.value)}
        className="mt-1 w-full rounded-md border border-border-soft bg-background px-3 py-2 text-sm text-text-primary focus:border-agent focus:outline-none"
      />

      <label className="mt-3 block text-xs font-medium text-text-secondary" htmlFor="pw-new">
        {t("auth.newPasswordLabel")}
      </label>
      <input
        id="pw-new"
        type="password"
        autoComplete="new-password"
        required
        minLength={10}
        value={next}
        onChange={(e) => setNext(e.target.value)}
        className="mt-1 w-full rounded-md border border-border-soft bg-background px-3 py-2 text-sm text-text-primary focus:border-agent focus:outline-none"
      />

      <label className="mt-3 block text-xs font-medium text-text-secondary" htmlFor="pw-confirm">
        {t("auth.confirmPasswordLabel")}
      </label>
      <input
        id="pw-confirm"
        type="password"
        autoComplete="new-password"
        required
        value={confirm}
        onChange={(e) => setConfirm(e.target.value)}
        className="mt-1 w-full rounded-md border border-border-soft bg-background px-3 py-2 text-sm text-text-primary focus:border-agent focus:outline-none"
      />

      {(mismatch || errorMessage) && (
        <p role="alert" className="mt-3 rounded-md border border-danger/30 bg-danger/10 px-3 py-2 text-xs text-danger">
          {mismatch ? t("auth.passwordMismatch") : errorMessage}
        </p>
      )}

      <button
        type="submit"
        disabled={submitting}
        className="mt-4 rounded-md bg-agent px-4 py-2 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
      >
        {submitting ? t("auth.changing") : t("auth.changePassword")}
      </button>
    </form>
  );
}
