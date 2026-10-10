// Small formatting helpers shared by the screens, the exports and the share text.

/** Remove control characters (line breaks, terminal codes) from text that came from a file, before it is shown or copied. */
export const plain = (text: unknown): string => String(text).replace(/[\u0000-\u001f\u007f-\u009f]/g, '');

/** A whole number with thousands separators: 6,360 */
export const formatCount = (n: number): string => (Number.isFinite(n) ? Math.round(n).toLocaleString('en-US') : '0');

/** Dollars with thousands separators and cents: $19,480.00 */
export const formatUsd = (n: number): string =>
  `$${(Number.isFinite(n) ? n : 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/**
 * A rounded figure for sentences that say "about". Cents under $10, whole dollars up to $100,
 * and tens above that, so an estimate does not look more exact than it is.
 */
export function formatApproxUsd(n: number): string {
  const value = Number.isFinite(n) ? Math.max(0, n) : 0;
  if (value >= 100) return `$${(Math.round(value / 10) * 10).toLocaleString('en-US')}`;
  if (value >= 10) return `$${Math.round(value)}`;
  return `$${value.toFixed(2)}`;
}

/**
 * The same rounding as formatApproxUsd, but always DOWN. For a figure that is a minimum ("at least"), rounding up
 * would claim more than we know: a minimum of $105.10 must not read "at least $110".
 */
export function formatAtLeastUsd(n: number): string {
  const value = Number.isFinite(n) ? Math.max(0, n) : 0;
  if (value >= 100) return `$${(Math.floor(value / 10) * 10).toLocaleString('en-US')}`;
  if (value >= 10) return `$${Math.floor(value)}`;
  // The small nudge keeps an exact amount such as 4.29 from landing on 4.28 through floating-point error
  return `$${(Math.floor(value * 100 + 1e-9) / 100).toFixed(2)}`;
}

/** "1 report", "2 reports" */
export const plural = (count: number, one: string, many = `${one}s`): string => `${formatCount(count)} ${count === 1 ? one : many}`;

/** Tokens in short form: 950, 1.2k, 3.4M, 1.1B. Rounds first, so 999,950 reads 1.0M and not 1000.0k. */
export const formatTokenNumber = (num: number): string => {
  const n = Number.isFinite(num) ? num : 0;
  if (Math.round(n / 1e5) >= 1e4) return (n / 1e9).toFixed(1) + 'B';
  if (Math.round(n / 1e2) >= 1e4) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'k';
  return Math.round(n).toString();
};

/** A day key like 2026-09-30 as a local calendar date. Never shifts with the time zone. */
export function parseDay(key: string): Date {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d);
}

const DAY_MS = 86_400_000;
const dayNumber = (key: string): number => {
  const [y, m, d] = key.split('-').map(Number);
  return Date.UTC(y, m - 1, d);
};

/** The day key a number of days before (negative) or after (positive) another. Whole days, so clock changes do not matter. */
export function shiftDay(key: string, delta: number): string {
  const d = new Date(dayNumber(key) + delta * DAY_MS);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

/** Whole days from one day key to another (0 when they are the same day). */
export const daysBetween = (startKey: string, endKey: string): number => Math.round((dayNumber(endKey) - dayNumber(startKey)) / DAY_MS);

/**
 * Every day key from start to end, both included. Counts whole days, not hours, so a clock change
 * (some zones jump at midnight) can never skip or repeat a day.
 */
export function calendarDays(startKey: string, endKey: string): string[] {
  const out: string[] = [];
  const last = dayNumber(endKey);
  for (let t = dayNumber(startKey); t <= last; t += DAY_MS) {
    const d = new Date(t);
    out.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`);
  }
  return out;
}

/** "Sep 30" */
export const formatDay = (key: string): string =>
  parseDay(key).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

/** A date or time stamp from a report, as "Sep 30, 2026". Falls back to the original text if it is not a date. */
export function formatDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? plain(iso) : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

/** A model id as people read it: "claude-sonnet-5-5" becomes "sonnet-5-5". Other makers' ids stay as they are. */
export const shortModelName = (model: string): string => plain(model).replace(/^claude-/, '');
