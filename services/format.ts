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

/** "Sep 30" */
export const formatDay = (key: string): string =>
  parseDay(key).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

/** A date or time stamp from a report, as "Sep 30, 2026". Falls back to the original text if it is not a date. */
export function formatDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? plain(iso) : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}
