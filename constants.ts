import { UsageReport } from "./types";

// Demo data. Totals are the sum of the daily rows, and the model split matches the totals.
export const MOCK_DATA: UsageReport = {
  provider: "anthropic",
  product: "claude",
  tool: "Claude Code",
  source: "demo",
  // The days below are calendar days on the viewer's clock, so the period is too (not UTC instants)
  period: {
    start: new Date(2026, 8, 1, 0, 0, 0).toISOString(),
    end: new Date(2026, 8, 15, 23, 59, 59).toISOString(),
  },
  plan: {
    name: "Claude Pro",
    price_usd: 20,
    type: "subscription",
  },
  usage: {
    tokens: {
      input: 363000,
      output: 91000,
      cached: 650000,
      by_model: {
        "claude-sonnet-5-5": { input: 240000, output: 65000, cache_read: 600000 },
        "claude-opus-5-5": { input: 80000, output: 18000, cache_read: 50000 },
        "claude-haiku-5-5": { input: 43000, output: 8000 },
      },
    },
    messages: {
      count: 125,
      by_day: [
        { date: "2026-09-01", count: 5, input: 15000, output: 2000 },
        { date: "2026-09-02", count: 12, input: 35000, output: 8000 },
        { date: "2026-09-03", count: 8, input: 22000, output: 4000 },
        { date: "2026-09-04", count: 2, input: 5000, output: 1000 },
        { date: "2026-09-05", count: 0, input: 0, output: 0 },
        { date: "2026-09-06", count: 15, input: 45000, output: 12000 },
        { date: "2026-09-07", count: 22, input: 65000, output: 18000 },
        { date: "2026-09-08", count: 4, input: 10000, output: 3000 },
        { date: "2026-09-09", count: 10, input: 28000, output: 6000 },
        { date: "2026-09-10", count: 18, input: 55000, output: 14000 },
        { date: "2026-09-11", count: 6, input: 18000, output: 5000 },
        { date: "2026-09-12", count: 9, input: 25000, output: 7000 },
        { date: "2026-09-13", count: 3, input: 8000, output: 2000 },
        { date: "2026-09-14", count: 0, input: 0, output: 0 },
        { date: "2026-09-15", count: 11, input: 32000, output: 9000 },
      ],
    },
    sessions: {
      count: 24,
    },
  },
};

/**
 * A demo report from daily rows and a model split. The totals are the sums of the rows, and the model split adds up
 * to the totals, the same promise MOCK_DATA keeps by hand.
 */
function demoReport(
  tool: string,
  product: NonNullable<UsageReport['product']>,
  provider: UsageReport['provider'],
  models: Array<[string, number]>,
  rows: Array<[string, number, number, number]>,
  cachedShare: number,
): UsageReport {
  const by_day = rows.map(([date, count, input, output]) => ({ date, count, input, output }));
  const input = by_day.reduce((sum, d) => sum + d.input, 0);
  const output = by_day.reduce((sum, d) => sum + d.output, 0);
  const by_model: UsageReport['usage']['tokens']['by_model'] = {};
  let inLeft = input;
  let outLeft = output;
  models.forEach(([model, share], i) => {
    const last = i === models.length - 1;
    const mi = last ? inLeft : Math.round(input * share);
    const mo = last ? outLeft : Math.round(output * share);
    inLeft -= mi;
    outLeft -= mo;
    by_model[model] = { input: mi, output: mo, cache_read: Math.round(mi * cachedShare) };
  });
  const cached = Object.values(by_model).reduce((sum, m) => sum + (m.cache_read ?? 0), 0);
  const [y1, m1, d1] = rows[0][0].split('-').map(Number);
  const [y2, m2, d2] = rows[rows.length - 1][0].split('-').map(Number);
  return {
    provider,
    product,
    tool,
    source: 'demo',
    period: { start: new Date(y1, m1 - 1, d1).toISOString(), end: new Date(y2, m2 - 1, d2, 23, 59, 59).toISOString() },
    plan: { name: 'Not set', price_usd: 0, type: 'subscription' },
    usage: {
      tokens: { input, output, cached, by_model },
      messages: { count: by_day.reduce((sum, d) => sum + d.count, 0), by_day },
      sessions: { count: 9 },
    },
  };
}

const CODEX_DEMO = demoReport('Codex CLI', 'chatgpt', 'openai', [['gpt-6.1-sol', 0.8], ['gpt-6-luna', 0.2]], [
  ['2026-09-01', 14, 900000, 60000], ['2026-09-02', 20, 1300000, 85000], ['2026-09-03', 9, 600000, 40000],
  ['2026-09-04', 0, 0, 0], ['2026-09-05', 0, 0, 0], ['2026-09-06', 25, 1600000, 110000],
  ['2026-09-07', 18, 1150000, 80000], ['2026-09-08', 11, 700000, 50000], ['2026-09-09', 16, 1000000, 70000],
  ['2026-09-10', 22, 1400000, 95000], ['2026-09-11', 0, 0, 0], ['2026-09-12', 13, 850000, 60000],
  ['2026-09-13', 8, 500000, 35000], ['2026-09-14', 19, 1200000, 85000], ['2026-09-15', 15, 950000, 65000],
], 4);

const GEMINI_DEMO = demoReport('Gemini CLI', 'gemini-api', 'google', [['gemini-3.1-pro-preview-customtools', 0.6], ['gemini-3.8-flash', 0.4]], [
  ['2026-09-02', 4, 120000, 9000], ['2026-09-03', 0, 0, 0], ['2026-09-04', 6, 180000, 14000],
  ['2026-09-05', 0, 0, 0], ['2026-09-06', 0, 0, 0], ['2026-09-07', 3, 90000, 7000],
  ['2026-09-08', 0, 0, 0], ['2026-09-09', 5, 150000, 11000], ['2026-09-10', 2, 60000, 5000],
  ['2026-09-11', 0, 0, 0], ['2026-09-12', 7, 210000, 16000], ['2026-09-13', 0, 0, 0],
  ['2026-09-14', 4, 120000, 9000], ['2026-09-15', 3, 90000, 7000],
], 1);

/** What "Try the demo" shows: one report per tool, like a real scan. */
export const DEMO_REPORTS: UsageReport[] = [MOCK_DATA, CODEX_DEMO, GEMINI_DEMO];
