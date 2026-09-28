import { createContext, useContext, useEffect, useMemo, useState, ReactNode } from "react";
import { API_V1 } from "./api/client";
import en from "./i18n/en.json";
import bn from "./i18n/bn.json";

/**
 * Feature 5: Multi-Language Interface and Document Support.
 *
 * Renders synchronously from the bundled (build-time) dictionaries — the
 * UI is never blank while a translation fetch is in flight or if the
 * backend is briefly unreachable (UROS_UI_UX_Direction.md: "No screen
 * may show only 'No data found.'") — then transparently overlays the
 * latest dictionary from `GET /api/v1/i18n/translations` once it
 * resolves. Deliberately independent of @tanstack/react-query so this
 * provider works standalone (no ambient QueryClientProvider required),
 * matching how the Applicant Portal is mounted separately from the
 * staff dashboard in main.tsx.
 */
export type SupportedLanguage = "en" | "bn";
export const SUPPORTED_LANGUAGES: SupportedLanguage[] = ["en", "bn"];

const BUNDLED: Record<SupportedLanguage, Record<string, string>> = {
  en: en as Record<string, string>,
  bn: bn as Record<string, string>,
};

const LANGUAGE_STORAGE_KEY = "uros_ui_language";

function isSupportedLanguage(value: string | null): value is SupportedLanguage {
  return value === "en" || value === "bn";
}

function readStoredLanguage(): SupportedLanguage {
  if (typeof window === "undefined") return "en";
  try {
    const stored = window.localStorage.getItem(LANGUAGE_STORAGE_KEY);
    return isSupportedLanguage(stored) ? stored : "en";
  } catch {
    // localStorage can throw in locked-down/private-browsing contexts —
    // fall back to the default rather than crashing the whole UI.
    return "en";
  }
}

async function fetchTranslationsFromServer(lang: SupportedLanguage): Promise<Record<string, string>> {
  const res = await fetch(`${API_V1}/i18n/translations?lang=${lang}`);
  if (!res.ok) {
    throw new Error(`Failed to load '${lang}' translations (HTTP ${res.status})`);
  }
  const body = (await res.json()) as { translations: Record<string, string> };
  return body.translations;
}

export interface I18nContextValue {
  language: SupportedLanguage;
  setLanguage: (lang: SupportedLanguage) => void;
  /** Translates `key`, optionally substituting `{{name}}` placeholders. Never throws — an unknown key renders as itself. */
  t: (key: string, vars?: Record<string, string>) => string;
}

const I18nContext = createContext<I18nContextValue | null>(null);

export function I18nProvider({ children }: { children: ReactNode }) {
  const [language, setLanguageState] = useState<SupportedLanguage>(() => readStoredLanguage());
  const [serverTranslations, setServerTranslations] = useState<Record<string, string> | null>(null);

  useEffect(() => {
    let cancelled = false;
    setServerTranslations(null);
    fetchTranslationsFromServer(language)
      .then((data) => {
        if (!cancelled) setServerTranslations(data);
      })
      .catch(() => {
        // Backend unreachable / offline: keep using the bundled
        // dictionary silently. A translation fetch failure must never
        // block or blank out the UI.
      });
    return () => {
      cancelled = true;
    };
  }, [language]);

  const setLanguage = (lang: SupportedLanguage) => {
    setLanguageState(lang);
    try {
      window.localStorage.setItem(LANGUAGE_STORAGE_KEY, lang);
    } catch {
      // Ignore storage failures — the in-memory state change still applies for this session.
    }
  };

  const translations = useMemo(
    () => ({ ...BUNDLED.en, ...BUNDLED[language], ...(serverTranslations ?? {}) }),
    [language, serverTranslations]
  );

  const t = useMemo(() => {
    return (key: string, vars?: Record<string, string>): string => {
      const template = translations[key] ?? key;
      if (!vars) return template;
      return Object.entries(vars).reduce((acc, [name, value]) => acc.split(`{{${name}}}`).join(value), template);
    };
  }, [translations]);

  const value = useMemo<I18nContextValue>(() => ({ language, setLanguage, t }), [language, t]);

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nContextValue {
  const ctx = useContext(I18nContext);
  if (!ctx) {
    throw new Error("useI18n() must be used within an <I18nProvider>");
  }
  return ctx;
}
