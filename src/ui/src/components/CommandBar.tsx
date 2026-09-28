import { useState } from "react";
import { useHealth } from "../api/hooks";
import { getToken, setToken, clearToken, authedRequest } from "../api/client";
import { useI18n } from "../i18n";
import { LanguageSwitcher } from "./LanguageSwitcher";
import type { SupportedLanguage } from "../i18n";

export function CommandBar() {
  const { data: health, isError } = useHealth();
  const [tokenInput, setTokenInput] = useState("");
  const [hasToken, setHasToken] = useState(!!getToken());
  const { t } = useI18n();

  function applyToken() {
    if (!tokenInput.trim()) return;
    setToken(tokenInput.trim());
    setHasToken(true);
    setTokenInput("");
    // Force queries gated on getToken() to re-evaluate `enabled`.
    window.location.reload();
  }

  function signOut() {
    clearToken();
    setHasToken(false);
    window.location.reload();
  }

  /**
   * Feature 5: best-effort sync of the staff user's dashboard language
   * choice to users.preferred_language, so it follows them across
   * devices/sessions. Local UI language (via useI18n/localStorage) has
   * already been applied by LanguageSwitcher regardless of whether this
   * call succeeds — a failed PATCH must never block or revert the UI
   * language change the person just made.
   */
  function persistLanguagePreference(lang: SupportedLanguage) {
    if (!hasToken) return;
    authedRequest("/users/me/language", {
      method: "PATCH",
      body: JSON.stringify({ preferred_language: lang }),
    }).catch(() => {
      // Non-fatal: the person's session-local language choice still applies.
    });
  }

  const statusColor = isError ? "bg-danger" : health?.status === "ok" ? "bg-success" : "bg-attention";
  const statusLabel = isError ? t("status.unreachable") : health?.status === "ok" ? t("status.live") : t("status.checking");

  return (
    <div className="flex items-center justify-between gap-4 border-b border-border-soft bg-surface px-6 py-3">
      <div className="flex items-center gap-4">
        <span className="text-lg font-semibold text-text-primary">{t("app.name")}</span>
        <span className="text-sm text-text-secondary">{t("app.tagline")}</span>
        <span className="flex items-center gap-1.5 rounded-full border border-border-soft px-2.5 py-1 text-xs text-text-secondary">
          <span className={`h-2 w-2 rounded-full ${statusColor}`} />
          {statusLabel}
          {health?.deployment_mode && <span className="text-text-secondary">· {health.deployment_mode}</span>}
        </span>
      </div>

      <div className="flex items-center gap-3">
        <LanguageSwitcher onLanguageChange={persistLanguagePreference} />

        {hasToken ? (
          <button
            onClick={signOut}
            className="rounded-md border border-border-soft px-3 py-1.5 text-xs text-text-secondary hover:bg-background"
          >
            {t("auth.clearToken")}
          </button>
        ) : (
          <div className="flex items-center gap-2">
            <input
              type="password"
              placeholder={t("auth.pasteTokenPlaceholder")}
              value={tokenInput}
              onChange={(e) => setTokenInput(e.target.value)}
              className="w-72 rounded-md border border-border-soft bg-background px-3 py-1.5 text-xs text-text-primary placeholder:text-text-secondary focus:border-agent focus:outline-none"
            />
            <button
              onClick={applyToken}
              className="rounded-md bg-agent px-3 py-1.5 text-xs font-medium text-white hover:opacity-90"
            >
              {t("auth.connect")}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
