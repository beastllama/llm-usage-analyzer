import { test } from 'node:test';
import assert from 'node:assert/strict';
import { calculateAnalysis, analyzeUsagePattern, spanDays } from '../services/analysisService.ts';
import { priceFor, tokenCost, PLANS } from '../services/pricing.ts';
import { getModelDistribution, calculateMonthlyTrends, pickNonOverlapping } from '../services/trendService.ts';
import { csvCell } from '../services/exportService.ts';
import { MOCK_DATA } from '../constants.ts';
import type { UsageReport, StoredReport } from '../types.ts';

const report = (overrides: Partial<UsageReport> = {}): UsageReport => ({
  ...MOCK_DATA,
  ...overrides,
  usage: { ...MOCK_DATA.usage, ...(overrides.usage || {}) },
});

test('demo data totals equal the sum of its daily rows', () => {
  const days = MOCK_DATA.usage.messages.by_day;
  const input = days.reduce((s, d) => s + d.input, 0);
  const output = days.reduce((s, d) => s + d.output, 0);
  const count = days.reduce((s, d) => s + d.count, 0);
  assert.equal(MOCK_DATA.usage.tokens.input, input);
  assert.equal(MOCK_DATA.usage.tokens.output, output);
  assert.equal(MOCK_DATA.usage.messages.count, count);

  const modelInput = Object.values(MOCK_DATA.usage.tokens.by_model).reduce((s, m) => s + m.input, 0);
  assert.equal(modelInput, input, 'model split must add up to the total');
});

test('the monthly estimate scales the period cost to 30 days', () => {
  // 1 day span, so monthly = period cost x 30
  const r = report({
    period: { start: '2026-10-01T00:00:00.000Z', end: '2026-10-01T10:00:00.000Z' },
    usage: {
      ...MOCK_DATA.usage,
      tokens: { input: 1_000_000, output: 0, by_model: { 'claude-opus-5-5': { input: 1_000_000, output: 0 } } },
    },
  } as Partial<UsageReport>);
  const cmp = calculateAnalysis(r, 'Claude Pro');
  assert.ok(Math.abs(cmp.apiCostPeriod - 4) < 1e-9, 'Opus 5.5 input is $4 per 1M');
  assert.ok(Math.abs(cmp.apiCostMonthly - 120) < 1e-9);
  // Pay-as-you-go ($120) costs more than Pro ($20), so the plan is the cheaper option
  assert.equal(cmp.verdict, 'keep');
  assert.equal(cmp.lowConfidence, true);
});

test('light API-equivalent use means pay-as-you-go is cheaper than a $200 plan', () => {
  const cmp = calculateAnalysis(report({
    period: { start: '2026-10-01T00:00:00.000Z', end: '2026-10-30T00:00:00.000Z' },
    usage: { ...MOCK_DATA.usage, tokens: { input: 100_000, output: 0, by_model: { 'claude-haiku-5-5': { input: 100_000, output: 0 } } } },
  } as Partial<UsageReport>), 'Claude Max 20x');
  assert.equal(cmp.verdict, 'switch');
  assert.equal(cmp.canJudge, true);
});

test('web-export tokens with no model name cannot be priced, so no verdict is made', () => {
  const cmp = calculateAnalysis(report({
    usage: { ...MOCK_DATA.usage, tokens: { input: 5000, output: 5000, by_model: { 'Claude (estimated)': { input: 5000, output: 5000 } } } },
  } as Partial<UsageReport>), 'Claude Pro');
  assert.equal(cmp.canJudge, false);
  assert.deepEqual(cmp.unpricedModels, ['Claude (estimated)']);
});

test('cache tokens are priced, not dropped', () => {
  const withCache = priceFor('claude-sonnet-5-5')!;
  assert.equal(withCache.cacheWrite, 2 * 1.25);
  assert.equal(withCache.cacheRead, 2 * 0.05);
});

test('a model id is its table key, or the key plus a date, -latest, or a context tag. Nothing else is guessed', () => {
  assert.equal(priceFor('claude-opus-5-5-20260315')?.input, 4);
  assert.equal(priceFor('claude-sonnet-4-5-20250929')?.input, 3);
  assert.equal(priceFor('claude-sonnet-4-5-20250929[1m]')?.input, 3);
  assert.equal(priceFor('claude-opus-4-6[1m]')?.input, 5);
  assert.equal(priceFor('claude-3-5-haiku-latest')?.input, 0.8);
  // Opus 5.5 is not Opus 5, and Opus 4 is not Opus 4.5
  assert.equal(priceFor('claude-opus-5-5')?.input, 4);
  assert.equal(priceFor('claude-opus-4-20250514')?.input, 15);
  assert.equal(priceFor('claude-opus-4-1-20250805')?.input, 15);
  assert.equal(priceFor('claude-opus-4-5-20251101')?.input, 5);
  assert.equal(priceFor('claude-sonnet-4-20250514')?.input, 3);
  // A newer id that is not in the table must not borrow an older model's price
  assert.equal(priceFor('claude-opus-5-6'), null);
  assert.equal(priceFor('claude-opus-5-6-20261201'), null);
  assert.equal(priceFor('claude-sonnet-5-6'), null);
  assert.equal(priceFor('claude-haiku-5-6'), null);
  assert.equal(priceFor('claude-fable-5-2'), null);
  assert.equal(priceFor('claude-mythos-preview'), null);
});

test('Fable and Mythos use the published prices and their own cache-read rates', () => {
  const fable51 = priceFor('claude-fable-5-1')!;
  assert.deepEqual([fable51.input, fable51.output, fable51.cacheRead, fable51.cacheWrite, fable51.cacheWrite1h], [10, 50, 0.25, 12.5, 20]);
  const fable5 = priceFor('claude-fable-5')!;
  assert.deepEqual([fable5.input, fable5.output, fable5.cacheRead], [10, 50, 1]);
  assert.equal(priceFor('claude-mythos-5-1')?.cacheRead, 0.25);
  assert.equal(priceFor('claude-mythos-5')?.cacheRead, 1);
});

test('retired Opus 4 and 4.1 are priced at their last listed rate', () => {
  const p = priceFor('claude-opus-4-1')!;
  assert.deepEqual([p.input, p.output, p.cacheRead, p.cacheWrite, p.cacheWrite1h], [15, 75, 1.5, 18.75, 30]);
});

test('models from other companies are not priced, because this tool is for Claude plans', () => {
  assert.equal(priceFor('gpt-4o'), null);
  assert.equal(priceFor('gpt-4o-2024-05-13'), null);
  assert.equal(priceFor('o1-2024-12-17'), null);
});

test('the usage pattern reports only facts, with calendar days and active days', () => {
  const p = analyzeUsagePattern(MOCK_DATA);
  assert.equal(p.activeDays, 13);
  assert.equal(p.periodDays, 15);
  assert.equal(p.peakDay?.count, 22);
  assert.equal(p.peakDay?.date, '2026-09-07');
  assert.equal(spanDays('2026-09-01T00:00:00Z', '2026-09-15T23:59:59Z'), 15);
});

test('the plan list covers all three Claude plans at their published prices', () => {
  assert.deepEqual(
    Object.entries(PLANS).map(([k, v]) => [k, v.price]),
    [['Claude Pro', 20], ['Claude Max 5x', 100], ['Claude Max 20x', 200]],
  );
});

test('spreadsheet cells are quoted and formula triggers are neutralised', () => {
  assert.equal(csvCell('=HYPERLINK("http://x")'), `"'=HYPERLINK(""http://x"")"`);
  assert.equal(csvCell('+1+1'), `"'+1+1"`);
  assert.equal(csvCell('plain'), 'plain');
  assert.equal(csvCell('a,b'), '"a,b"');
  assert.equal(csvCell(42), '42');
});

test('a model named __proto__ cannot pollute the distribution', () => {
  const stored: StoredReport[] = [{
    id: 'x', savedAt: '2026-10-01T00:00:00.000Z', name: 'x',
    report: report({
      usage: { ...MOCK_DATA.usage, tokens: { input: 10, output: 10, by_model: JSON.parse('{"__proto__":{"input":10,"output":10}}') } },
    } as Partial<UsageReport>),
  }];
  const dist = getModelDistribution(stored);
  assert.equal(dist.length, 1);
  assert.equal(({} as any).input, undefined, 'Object.prototype must be untouched');
});

test('a report spanning two months is split between them, not dumped into the first', () => {
  const stored: StoredReport[] = [{
    id: 'span', savedAt: '2026-10-01T00:00:00.000Z', name: 'span',
    report: report({
      period: { start: '2026-09-30T00:00:00.000Z', end: '2026-10-02T00:00:00.000Z' },
      usage: {
        ...MOCK_DATA.usage,
        tokens: { input: 300, output: 0, by_model: { 'claude-opus-5-5': { input: 300, output: 0 } } },
        messages: { count: 3, by_day: [
          { date: '2026-09-30', count: 1, input: 100, output: 0 },
          { date: '2026-10-01', count: 1, input: 100, output: 0 },
          { date: '2026-10-02', count: 1, input: 100, output: 0 },
        ] },
      },
    } as Partial<UsageReport>),
  }];
  const months = calculateMonthlyTrends(stored);
  assert.deepEqual(months.map(m => m.period), ['2026-09', '2026-10']);
  assert.ok(Math.abs(months[0].totalCost - (100 / 300) * (300 * 4 / 1e6)) < 1e-12);
  assert.equal(months[1].activeDays, 2);
});

test('span counts calendar days, not hours: 20:00 on day 1 to 08:00 on day 9 is 9 days', () => {
  assert.equal(spanDays(new Date(2026, 9, 1, 20, 0).toISOString(), new Date(2026, 9, 9, 8, 0).toISOString()), 9);
  assert.equal(spanDays(new Date(2026, 9, 3, 20, 0).toISOString(), new Date(2026, 9, 9, 8, 0).toISOString()), 7);
});

test('1-hour cache writes are priced at 2x input, not at the 5-minute rate', () => {
  const p = priceFor('claude-sonnet-5-5')!;
  assert.equal(p.cacheWrite1h, 4);
  const r = tokenCost('claude-sonnet-5-5', { input: 0, output: 0, cache_write_1h: 1_000_000 });
  assert.ok(Math.abs(r.cost - 4) < 1e-9, `expected $4 for 1M 1-hour writes, got ${r.cost}`);
});

test('a report saved twice (same days) is counted once in the trends', () => {
  const day = (date: string) => ({ date, count: 1, input: 100, output: 0 });
  const older: StoredReport = {
    id: 'old', savedAt: '2026-10-05T00:00:00.000Z', name: 'old',
    report: report({ period: { start: '2026-10-01T00:00:00Z', end: '2026-10-05T00:00:00Z' }, usage: { ...MOCK_DATA.usage, tokens: { input: 300, output: 0, by_model: { 'claude-opus-5-5': { input: 300, output: 0 } } }, messages: { count: 3, by_day: [day('2026-10-01'), day('2026-10-02'), day('2026-10-03')] } } } as Partial<UsageReport>),
  };
  const newer: StoredReport = {
    id: 'new', savedAt: '2026-10-09T00:00:00.000Z', name: 'new',
    report: report({ period: { start: '2026-10-01T00:00:00Z', end: '2026-10-09T00:00:00Z' }, usage: { ...MOCK_DATA.usage, tokens: { input: 900, output: 0, by_model: { 'claude-opus-5-5': { input: 900, output: 0 } } }, messages: { count: 9, by_day: [1,2,3,4,5,6,7,8,9].map(n => day('2026-10-0' + n)) } } } as Partial<UsageReport>),
  };
  assert.deepEqual(pickNonOverlapping([older, newer]).map(s => s.id), ['new']);
  const totals = calculateMonthlyTrends([older, newer]);
  assert.equal(totals[0].messageCount, 9, 'nine days, each once');
  assert.equal(getModelDistribution([older, newer])[0].tokens, 900);
});

