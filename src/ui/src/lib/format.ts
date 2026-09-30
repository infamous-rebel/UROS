/**
 * Quest 05 Part 10 — Format helpers for i18n.
 * Uses Intl APIs for locale-aware formatting.
 */

/** Format a date for the given locale */
export function formatDate(date: string | Date | null | undefined, locale: string = "en"): string {
  if (!date) return "—";
  const d = typeof date === "string" ? new Date(date) : date;
  if (Number.isNaN(d.getTime())) return "—";
  const lang = locale === "bn" ? "bn-BD" : "en-US";
  return new Intl.DateTimeFormat(lang, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(d);
}

/** Format a number for the given locale */
export function formatNumber(num: number | null | undefined, locale: string = "en"): string {
  if (num == null) return "—";
  const lang = locale === "bn" ? "bn-BD" : "en-US";
  return new Intl.NumberFormat(lang).format(num);
}

/** Format a currency amount */
export function formatCurrency(
  amount: number | null | undefined,
  currency: string = "BDT",
  locale: string = "en",
): string {
  if (amount == null) return "—";
  const lang = locale === "bn" ? "bn-BD" : "en-US";
  return new Intl.NumberFormat(lang, {
    style: "currency",
    currency,
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(amount);
}

/** Format a phone number (Bangladeshi format) */
export function formatPhone(phone: string | null | undefined, _locale: string = "en"): string {
  if (!phone) return "—";
  const digits = phone.replace(/\D/g, "");
  if (digits.startsWith("880") && digits.length === 13) {
    return `+880 ${digits[3]}${digits[4]} ${digits.slice(5, 9)}-${digits.slice(9)}`;
  }
  if (digits.length === 11 && digits.startsWith("01")) {
    return `+880 ${digits[2]} ${digits.slice(3, 7)}-${digits.slice(7)}`;
  }
  return phone;
}

/** Format relative time ("5 minutes ago") */
export function formatRelativeTime(date: string | Date | null | undefined, locale: string = "en"): string {
  if (!date) return "—";
  const d = typeof date === "string" ? new Date(date) : date;
  if (Number.isNaN(d.getTime())) return "—";

  const now = Date.now();
  const diff = now - d.getTime();
  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  const lang = locale === "bn" ? "bn" : "en";

  try {
    const rtf = new Intl.RelativeTimeFormat(lang, { numeric: "auto" });
    if (days > 0) return rtf.format(-days, "day");
    if (hours > 0) return rtf.format(-hours, "hour");
    if (minutes > 0) return rtf.format(-minutes, "minute");
    return rtf.format(-seconds, "second");
  } catch {
    // Fallback for locales without RelativeTimeFormat
    if (days > 0) return locale === "bn" ? `${days} দিন আগে` : `${days}d ago`;
    if (hours > 0) return locale === "bn" ? `${hours} ঘণ্টা আগে` : `${hours}h ago`;
    if (minutes > 0) return locale === "bn" ? `${minutes} মিনিট আগে` : `${minutes}m ago`;
    return locale === "bn" ? "এইমাত্র" : "just now";
  }
}
