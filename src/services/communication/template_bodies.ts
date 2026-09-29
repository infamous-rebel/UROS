/**
 * Communication template bodies — deterministic, versioned, human-authored.
 *
 * Mirrors the TEMPLATE_LANGUAGE_VARIANTS pattern (data, not runtime
 * inference): every registered (template_code, language) pair has exactly
 * one authored body. Bodies interpolate {{params}} — interpolation is a
 * strict replace of known keys; unknown keys are left verbatim and logged
 * by the renderer. No LLM, no randomness (deterministic scoring rule).
 *
 * Extend this table as new templates are authored. A template registered
 * in TEMPLATE_LANGUAGE_VARIANTS without a body here fails loudly at
 * render time — never silently sends an empty message.
 */

import { SupportedLanguage } from "../i18n/translations";

export type CommunicationTemplateCode =
  | "APPLICATION_RECEIVED"
  | "SHORTLISTED"
  | "REJECTION"
  | "INTERVIEW_SCHEDULE"
  | "FINAL_SELECTION"
  | "APPLICANT_PORTAL_OTP"
  | "REDISCOVERY_INVITE";

export type TemplateParams = Record<string, string | number>;

const BODIES: Record<CommunicationTemplateCode, Record<SupportedLanguage, string>> = {
  APPLICATION_RECEIVED: {
    en: "Dear {{candidate_name}}, your application for {{position}} at {{org_name}} has been received. Reference: {{candidate_id}}.",
    bn: "প্রিয় {{candidate_name}}, {{org_name}}-এ {{position}} পদের জন্য আপনার আবেদন গৃহীত হয়েছে। রেফারেন্স: {{candidate_id}}।",
  },
  SHORTLISTED: {
    en: "Dear {{candidate_name}}, congratulations — you have been shortlisted for {{position}} at {{org_name}}. Our team will contact you shortly.",
    bn: "প্রিয় {{candidate_name}}, অভিনন্দন — {{org_name}}-এ {{position}} পদের জন্য আপনি স্বল্প তালিকাভুক্ত হয়েছেন। আমাদের দল শীঘ্রই যোগাযোগ করবে।",
  },
  REJECTION: {
    en: "Dear {{candidate_name}}, thank you for applying to {{position}} at {{org_name}}. After careful review, we are unable to move forward with your application. We wish you success.",
    bn: "প্রিয় {{candidate_name}}, {{org_name}}-এ {{position}} পদে আবেদনের জন্য ধন্যবাদ। যত্নপূর্বক মূল্যায়নের পরে আমরা আপনার আবেদন এগিয়ে নিতে পারছি না। আপনার জন্য শুভকামনা।",
  },
  INTERVIEW_SCHEDULE: {
    en: "Dear {{candidate_name}}, your interview for {{position}} at {{org_name}} is scheduled on {{interview_time}}. Venue: {{location}}.",
    bn: "প্রিয় {{candidate_name}}, {{org_name}}-এ {{position}} পদের সাক্ষাৎকার {{interview_time}} তারিখে নির্ধারিত। স্থান: {{location}}।",
  },
  FINAL_SELECTION: {
    en: "Dear {{candidate_name}}, congratulations! You have been selected for {{position}} at {{org_name}}. Our HR team will share the offer details shortly.",
    bn: "প্রিয় {{candidate_name}}, অভিনন্দন! {{org_name}}-এ {{position}} পদের জন্য আপনি নির্বাচিত হয়েছেন। আমাদের এইচআর দল শীঘ্রই অফারের বিবরণ জানাবে।",
  },
  APPLICANT_PORTAL_OTP: {
    en: "Your UROS applicant portal verification code is {{otp}}. It expires in 10 minutes. Do not share this code.",
    bn: "আপনার UROS আবেদনকারী পোর্টাল যাচাইকরণ কোড {{otp}}। এটি ১০ মিনিটে মেয়াদ শেষ হবে। এই কোড শেয়ার করবেন না।",
  },
  REDISCOVERY_INVITE: {
    en: "Dear {{candidate_name}}, you previously applied for {{position}} at {{org_name}}. A matching new opening is available and we would like to invite you to re-apply. Reference: {{candidate_id}}.",
    bn: "প্রিয় {{candidate_name}}, {{org_name}}-এ {{position}} পদের জন্য আপনি পূর্বে আবেদন করেছিলেন। একটি সমতুল্য নতুন পদ খোলা হয়েছে — আবেদন করতে আমরা আপনাকে আমন্ত্রণ জানাচ্ছি। রেফারেন্স: {{candidate_id}}।",
  },
};

/** Renders a template body with strict parameter interpolation. */
export function renderTemplateBody(
  templateCode: string,
  language: SupportedLanguage,
  params: TemplateParams
): string {
  const variants = BODIES[templateCode as CommunicationTemplateCode];
  if (!variants) {
    throw new Error(
      `Template '${templateCode}' has no authored body. Register it in template_bodies.ts before sending.`
    );
  }
  const body = variants[language] ?? variants.en;
  return body.replace(/\{\{(\w+)\}\}/g, (_match, key: string) =>
    key in params ? String(params[key]) : `{{${key}}}`
  );
}

/** Lists template codes that have authored bodies. */
export function listAuthoredTemplates(): string[] {
  return Object.keys(BODIES);
}
