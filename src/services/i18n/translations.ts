import en from "../../i18n/en.json";
import bn from "../../i18n/bn.json";

/**
 * Feature 5: Multi-Language Interface and Document Support.
 *
 * Translation content is static, versioned, human-authored JSON shipped
 * with the codebase — never generated at request time and never LLM-
 * dependent (BYOK_Requirement.md: "no external AI service required").
 * This mirrors the same "human-authored, deterministic, versioned"
 * pattern used for rule packs elsewhere in UROS.
 */
export type SupportedLanguage = "en" | "bn";
export const SUPPORTED_LANGUAGES: [SupportedLanguage, ...SupportedLanguage[]] = ["en", "bn"];

const DICTIONARIES: Record<SupportedLanguage, Record<string, string>> = {
  en: en as Record<string, string>,
  bn: bn as Record<string, string>,
};

export function isSupportedLanguage(value: string | null | undefined): value is SupportedLanguage {
  return value === "en" || value === "bn";
}

/**
 * Returns the full translation map for a language. English is the
 * canonical key set: any key missing from a non-English dictionary
 * falls back to its English string rather than being omitted, so the
 * UI never renders a blank/undefined label for an untranslated key
 * (UROS_UI_UX_Direction.md: "No screen may show only 'No data found.'").
 */
export function getTranslations(lang: SupportedLanguage): Record<string, string> {
  const overlay = DICTIONARIES[lang] ?? {};
  return { ...DICTIONARIES.en, ...overlay };
}
