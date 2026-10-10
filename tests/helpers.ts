import { MOCK_DATA } from '../constants.ts';
import type { StoredReport, UsageReport } from '../types.ts';

/** A moment on the viewer's own clock, as the ISO text a report stores. Reports are read on the local calendar. */
export const at = (y: number, m: number, d: number, h = 0, min = 0) => new Date(y, m - 1, d, h, min).toISOString();

/** The demo report with some fields replaced. */
export const report = (overrides: Partial<UsageReport> = {}): UsageReport => ({
  ...MOCK_DATA,
  ...overrides,
  usage: { ...MOCK_DATA.usage, ...(overrides.usage || {}) },
});

/** A copy that shares nothing with the original, so a test can damage it. */
export const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value));

/**
 * One-day report of Sonnet 5.5 input tokens ($2 per 1M), so the monthly pay-as-you-go cost is
 * tokens x 2 / 1M x 30. 340,000 tokens give $20.40 a month.
 */
export function oneDay(opts: { tokens: number; replies?: number; unfinished?: number; days?: number; model?: string }): UsageReport {
  const days = opts.days ?? 1;
  const model = opts.model ?? 'claude-sonnet-5-5';
  return report({
    period: { start: at(2026, 10, 1), end: at(2026, 10, days, 10) },
    usage: {
      tokens: { input: opts.tokens, output: 0, by_model: { [model]: { input: opts.tokens, output: 0 } } },
      messages: { count: opts.replies ?? 10, by_day: [{ date: '2026-10-01', count: opts.replies ?? 10, input: opts.tokens, output: 0 }], unfinished: opts.unfinished },
      sessions: { count: 1 },
    },
  } as Partial<UsageReport>);
}

/** Day keys for one month: daysOf('2026-09', 3) is 2026-09-01, -02, -03. */
export const daysOf = (month: string, count: number, from = 1) =>
  Array.from({ length: count }, (_, i) => `${month}-${String(from + i).padStart(2, '0')}`);

const dayParts = (key: string): [number, number, number] => [+key.slice(0, 4), +key.slice(5, 7), +key.slice(8, 10)];

/**
 * A saved report with one reply and 1,000 input tokens on each of the given days (Sonnet 5.5 by default, $0.002 a day).
 * `unfinished` is how many of the replies were cut short in the log.
 */
export function storedReport(id: string, days: string[], savedAt: string, opts: { model?: string; unfinished?: number } = {}): StoredReport {
  const model = opts.model ?? 'claude-sonnet-5-5';
  return {
    id, savedAt, name: id,
    report: report({
      period: { start: at(...dayParts(days[0])), end: at(...dayParts(days[days.length - 1])) },
      usage: {
        tokens: { input: days.length * 1000, output: 0, by_model: { [model]: { input: days.length * 1000, output: 0 } } },
        messages: { count: days.length, by_day: days.map((date) => ({ date, count: 1, input: 1000, output: 0 })), unfinished: opts.unfinished },
        sessions: { count: 1 },
      },
    } as Partial<UsageReport>),
  };
}
