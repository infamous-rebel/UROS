import { useState, useEffect } from "react";
import { useHealth } from "../api/hooks";
import { getToken, setToken, clearToken, authedRequest, getAccessToken } from "../api/client";
import { useAuth } from "../auth/AuthContext";
import { useI18n } from "../i18n";
import { LanguageSwitcher } from "./LanguageSwitcher";
import type { SupportedLanguage } from "../i18n";

// Quest 05 Part 1c: the dev-token paste is removed from the ordinary UI.
// It survives only behind an explicit double flag (dev build + env opt-in)
// for service-token workflows (e.g. driving the stateless-token path of
// the auth middleware); it never holds a person's session.
const DEV_AUTH_ENABLED =
  Boolean((import.meta as any).env?.DEV) && (import.meta as any).env?.VITE_DEV_AUTH_ENABLED === "true";

export function CommandBar() {
  const { data: health, isError, isLoading } = useHealth();
  const { user, signOut } = useAuth();
  const [tokenInput, setTokenInput] = useState("");
  const { t } = useI18n();
  const [timedOut, setTimedOut] = useState(false);

  // Show "unreachable" after 5 seconds if still loading
  useEffect(() => {
    if (isLoading) {
      const timer = setTimeout(() => setTimedOut(true), 5000);
      return () => clearTimeout(timer);
    } else {
      setTimedOut(false);
    }
  }, [isLoading]);

  function applyToken() {
    if (!tokenInput.trim()) return;
    setToken(tokenInput.trim());
    setTokenInput("");
    // Force queries gated on getToken() to re-evaluate `enabled`.
    window.location.reload();
  }

  function persistLanguagePreference(lang: SupportedLanguage) {
    if (!getToken()) return;
    authedRequest("/users/me/language", {
      method: "PATCH",
      body: JSON.stringify({ preferred_language: lang }),
    }).catch(() => {
      // Non-fatal: the person's session-local language choice still applies.
    });
  }

  const statusColor = isError || timedOut ? "bg-danger" : health?.status === "ok" ? "bg-success" : "bg-attention";
  const statusLabel = isError || timedOut ? t("status.unreachable") : health?.status === "ok" ? t("status.live") : t("status.checking");

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

        {user ? (
          <>
            <span className="flex items-center gap-2 rounded-full border border-border-soft bg-background px-3 py-1.5 text-xs">
              <span className="text-text-primary">{user.email}</span>
              <span className="rounded-full bg-agent/10 px-2 py-0.5 font-medium text-agent">{user.role}</span>
            </span>
            <a
              href="#/sessions"
              className="rounded-md border border-border-soft px-3 py-1.5 text-xs text-text-secondary hover:bg-background"
            >
              {t("auth.sessions")}
            </a>
            <a
              href="#/password"
              className="rounded-md border border-border-soft px-3 py-1.5 text-xs text-text-secondary hover:bg-background"
            >
              {t("auth.password")}
            </a>
            <button
              onClick={() => {
                void signOut();
              }}
              className="rounded-md border border-border-soft px-3 py-1.5 text-xs text-text-secondary hover:bg-background"
            >
              {t("auth.signOut")}
            </button>
          </>
        ) : DEV_AUTH_ENABLED && !getAccessToken() ? (
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
            <button
              onClick={() => {
                clearToken();
                window.location.reload();
              }}
              className="rounded-md border border-border-soft px-3 py-1.5 text-xs text-text-secondary hover:bg-background"
            >
              {t("auth.clearToken")}
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
