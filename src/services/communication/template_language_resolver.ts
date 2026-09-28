import { SupportedLanguage, isSupportedLanguage } from "../i18n/translations";

/**
 * Feature 5: Multi-Language Interface and Document Support.
 *
 * Deterministic registry of which language variants exist for each base
 * communication template_code. This is intentionally data, not runtime
 * inference — it mirrors the versioned, human-authored rule-pack pattern
 * already used elsewhere in UROS rather than an LLM guessing what
 * variants "should" exist. Extend this list as new template variants are
 * authored (Section 9 of file 20-29_Supplementary_Modules.md).
 */
export const TEMPLATE_LANGUAGE_VARIANTS: Record<string, SupportedLanguage[]> = {
  APPLICATION_RECEIVED: ["en", "bn"],
  SHORTLISTED: ["en", "bn"],
  REJECTION: ["en", "bn"],
  INTERVIEW_SCHEDULE: ["en", "bn"],
  FINAL_SELECTION: ["en", "bn"],
  APPLICANT_PORTAL_OTP: ["en"],
};

export type TemplateLanguageReasonCode =
  | "TEMPLATE_LANGUAGE_MATCHED_CANDIDATE"
  | "TEMPLATE_LANGUAGE_FALLBACK_TO_ORG_DEFAULT"
  | "TEMPLATE_LANGUAGE_FALLBACK_TO_EN";

export interface TemplateLanguageResolution {
  /** The language variant actually selected. Always a SupportedLanguage — never unresolved. */
  language: SupportedLanguage;
  /** e.g. "SHORTLISTED_BN" — the concrete, language-specific template code to render/send. */
  resolved_template_code: string;
  fallback_applied: boolean;
  reason_code: TemplateLanguageReasonCode;
  reason_description: string;
}

/**
 * Selects which language variant of a communication template to send.
 *
 * Deterministic precedence (same input always yields same output):
 *   1. Candidate's own preferred_language, IF a variant exists for it.
 *   2. Organization's default_language, IF a variant exists for it.
 *   3. 'en' (guaranteed fallback — English variants are required for
 *      every template registered above).
 *
 * Per UROS_Global_Reasoning_Standard.md, the result always carries a
 * reason_code and human-readable reason_description explaining exactly
 * which branch fired and why, so a caller can log it verbatim to the
 * audit trail — never a bare "here's a template code" with no evidence.
 */
export function resolveTemplateLanguage(
  baseTemplateCode: string,
  candidatePreferredLanguage: string | null | undefined,
  orgDefaultLanguage: string | null | undefined
): TemplateLanguageResolution {
  const supportedForTemplate = TEMPLATE_LANGUAGE_VARIANTS[baseTemplateCode] ?? ["en"];

  const candidateLang = isSupportedLanguage(candidatePreferredLanguage) ? candidatePreferredLanguage : undefined;
  const orgLang = isSupportedLanguage(orgDefaultLanguage) ? orgDefaultLanguage : undefined;

  if (candidateLang && supportedForTemplate.includes(candidateLang)) {
    return {
      language: candidateLang,
      resolved_template_code: `${baseTemplateCode}_${candidateLang.toUpperCase()}`,
      fallback_applied: false,
      reason_code: "TEMPLATE_LANGUAGE_MATCHED_CANDIDATE",
      reason_description: `Candidate's preferred language '${candidateLang}' has a variant of template '${baseTemplateCode}'.`,
    };
  }

  if (orgLang && supportedForTemplate.includes(orgLang)) {
    return {
      language: orgLang,
      resolved_template_code: `${baseTemplateCode}_${orgLang.toUpperCase()}`,
      fallback_applied: true,
      reason_code: "TEMPLATE_LANGUAGE_FALLBACK_TO_ORG_DEFAULT",
      reason_description: candidateLang
        ? `Candidate's preferred language '${candidateLang}' has no variant of template '${baseTemplateCode}'; fell back to the organization's default language '${orgLang}'.`
        : `Candidate has no preferred_language set; fell back to the organization's default language '${orgLang}' for template '${baseTemplateCode}'.`,
    };
  }

  return {
    language: "en",
    resolved_template_code: `${baseTemplateCode}_EN`,
    fallback_applied: true,
    reason_code: "TEMPLATE_LANGUAGE_FALLBACK_TO_EN",
    reason_description: `Neither the candidate's preferred language${candidateLang ? ` ('${candidateLang}')` : ""} nor the organization's default language${orgLang ? ` ('${orgLang}')` : ""} has a variant of template '${baseTemplateCode}'; fell back to 'en'.`,
  };
}
