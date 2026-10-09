import { UsageReport } from "./types";

// Demo data. Totals are the sum of the daily rows, and the model split matches the totals.
export const MOCK_DATA: UsageReport = {
  provider: "anthropic",
  source: "demo",
  period: {
    start: "2026-09-01T00:00:00.000Z",
    end: "2026-09-15T23:59:59.000Z",
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
