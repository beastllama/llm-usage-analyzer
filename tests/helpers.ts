import { MOCK_DATA } from '../constants.ts';
import type { UsageReport } from '../types.ts';

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
export function oneDay(opts: { tokens: number; replies?: number; unfinished?: number; days?: number }): UsageReport {
  const days = opts.days ?? 1;
  return report({
    period: { start: at(2026, 10, 1), end: at(2026, 10, days, 10) },
    usage: {
      tokens: { input: opts.tokens, output: 0, by_model: { 'claude-sonnet-5-5': { input: opts.tokens, output: 0 } } },
      messages: { count: opts.replies ?? 10, by_day: [{ date: '2026-10-01', count: opts.replies ?? 10, input: opts.tokens, output: 0 }], unfinished: opts.unfinished },
      sessions: { count: 1 },
    },
  } as Partial<UsageReport>);
}
