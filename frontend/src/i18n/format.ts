import i18n from "./index";

export function formatNumber(n: number): string {
  if (n >= 1e9) return (n / 1e9).toFixed(1) + "B";
  if (n >= 1e6) return (n / 1e6).toFixed(1) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(1) + "K";
  return n.toLocaleString();
}

type DateInput = Date | string | number;

/** Active app language, not the OS/browser locale. */
function activeLocale(): string {
  return i18n.resolvedLanguage || i18n.language || "en";
}

function toDate(value: DateInput): Date | null {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

/** One formatter per language + option set: rows render in bulk (file lists,
 *  memory history), so rebuilding Intl objects per cell is measurable. */
function formatter(dateOnly: boolean, options?: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const locale = activeLocale();
  const cacheKey = `${locale}|${dateOnly ? "date" : "dateTime"}|${options ? JSON.stringify(options) : ""}`;
  const cached = formatters.get(cacheKey);
  if (cached) return cached;
  const resolved = dateOnly
    ? { year: "numeric" as const, month: "numeric" as const, day: "numeric" as const }
    : { year: "numeric" as const, month: "numeric" as const, day: "numeric" as const, hour: "numeric" as const, minute: "numeric" as const, second: "numeric" as const };
  const created = new Intl.DateTimeFormat(locale, { ...resolved, ...options });
  formatters.set(cacheKey, created);
  return created;
}

/** Date only (no time) in the active app language; unparsable input is returned verbatim. */
export function formatDate(value: DateInput, options?: Intl.DateTimeFormatOptions): string {
  const date = toDate(value);
  return date ? formatter(true, options).format(date) : String(value);
}

/** Date and time in the active app language; unparsable input is returned verbatim. */
export function formatDateTime(value: DateInput, options?: Intl.DateTimeFormatOptions): string {
  const date = toDate(value);
  return date ? formatter(false, options).format(date) : String(value);
}
