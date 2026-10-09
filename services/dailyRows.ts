import type { UsageReport } from '../types';
import { calendarDays, daysBetween } from './format';

type Day = UsageReport['usage']['messages']['by_day'][number];

/** Past this many days the quiet days are not filled in (a chart that wide could not show them anyway). About three years. */
export const MAX_FILLED_DAYS = 1100;

/**
 * The daily rows with the quiet days filled in as zero, so a chart's time axis has no gaps.
 * Days are whole calendar days, so a clock change (some zones jump at midnight) never drops or repeats one.
 */
export function withQuietDays(rows: Day[]): Day[] {
  if (rows.length < 2) return rows;
  const sorted = [...rows].sort((a, b) => a.date.localeCompare(b.date));
  const first = sorted[0].date;
  const last = sorted[sorted.length - 1].date;
  if (daysBetween(first, last) > MAX_FILLED_DAYS) return sorted;
  const byDate = new Map(sorted.map((d) => [d.date, d]));
  return calendarDays(first, last).map((date) => byDate.get(date) ?? { date, count: 0, input: 0, output: 0 });
}
