import { useI18n, SUPPORTED_LANGUAGES, SupportedLanguage } from "../i18n";

const LANGUAGE_LABEL_KEY: Record<SupportedLanguage, string> = {
  en: "language.en",
  bn: "language.bn",
};

export interface LanguageSwitcherProps {
  /**
   * Optional hook for the parent to persist the choice server-side
   * (users.preferred_language or candidates.preferred_language,
   * depending on which surface mounts this). The switcher itself has no
   * opinion on auth — it only updates local UI state + localStorage via
   * `useI18n().setLanguage`; the parent decides whether/how to sync a
   * server-side preference.
   */
  onLanguageChange?: (lang: SupportedLanguage) => void;
  className?: string;
}

/**
 * Feature 5: Multi-Language Interface and Document Support.
 * Always-visible, two-option toggle (no dead space, no hidden menu) per
 * UROS_UI_UX_Direction.md. Uses the existing UROS color tokens: the
 * active language reads as a human-facing choice (terracotta), matching
 * every other "this is a person's decision" affordance in the system.
 */
export function LanguageSwitcher({ onLanguageChange, className }: LanguageSwitcherProps) {
  const { language, setLanguage, t } = useI18n();

  function selectLanguage(lang: SupportedLanguage) {
    if (lang === language) return;
    setLanguage(lang);
    onLanguageChange?.(lang);
  }

  return (
    <div
      role="group"
      aria-label={t("language.switcherLabel")}
      className={`flex items-center gap-1 rounded-full border border-border-soft p-0.5 text-xs ${className ?? ""}`}
    >
      {SUPPORTED_LANGUAGES.map((lang) => (
        <button
          key={lang}
          type="button"
          aria-pressed={language === lang}
          onClick={() => selectLanguage(lang)}
          className={`rounded-full px-2.5 py-1 font-medium transition-colors ${
            language === lang ? "bg-human text-white" : "text-text-secondary hover:bg-background"
          }`}
        >
          {t(LANGUAGE_LABEL_KEY[lang])}
        </button>
      ))}
    </div>
  );
}
