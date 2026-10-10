import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { calculateAnalysis, analyzeUsagePattern, spanDays } from '../services/analysisService.ts';
import { priceFor, tokenCost, PLANS } from '../services/pricing.ts';
import { getModelDistribution, calculateMonthlyTrends, pickNonOverlapping, analyzeUsageTrends, getWeekdayHeatmap, getDailyBreakdown, formatMonth } from '../services/trendService.ts';
import { csvCell } from '../services/exportService.ts';
import { MOCK_DATA } from '../constants.ts';
import type { UsageReport, StoredReport } from '../types.ts';
import { at, report, oneDay, daysOf, storedReport } from './helpers.ts';

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
    period: { start: at(2026, 10, 1), end: at(2026, 10, 1, 10) },
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
    period: { start: at(2026, 10, 1), end: at(2026, 10, 30) },
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

test('OpenAI and Gemini models are priced; unknown and newer models are not guessed', () => {
  assert.equal(priceFor('gpt-6.1-sol')?.input, 2);
  assert.equal(priceFor('gemini-3.8-flash')?.output, 3.75);
  // A dated snapshot is the model, except one with its own published price
  assert.equal(priceFor('gpt-4o-2024-08-06')?.input, 2.5);
  assert.equal(priceFor('gpt-4o-2024-05-13')?.input, 5);
  assert.equal(priceFor('o1-2024-12-17')?.input, 15);
  // Not on the pricing pages, so not priced
  assert.equal(priceFor('gpt-6.2-sol'), null);
  assert.equal(priceFor('gemini-3.5-flash'), null);
  assert.equal(priceFor('codex-auto-review'), null);
  assert.equal(priceFor('grok-4'), null);
  // A name that only starts like a known model is not that model
  assert.equal(priceFor('gpt-5-mini-turbo'), null);
});

test('the usage pattern reports only facts, with calendar days and active days', () => {
  const p = analyzeUsagePattern(MOCK_DATA);
  assert.equal(p.activeDays, 13);
  assert.equal(p.periodDays, 15);
  assert.equal(p.peakDay?.count, 22);
  assert.equal(p.peakDay?.date, '2026-09-07');
  assert.equal(spanDays(at(2026, 9, 1), at(2026, 9, 15, 23, 59)), 15);
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
      usage: {
        ...MOCK_DATA.usage,
        // One priced model, so the report counts in Trends, and one with the dangerous name
        tokens: { input: 20, output: 20, by_model: JSON.parse('{"claude-sonnet-5-5":{"input":10,"output":10},"__proto__":{"input":10,"output":10}}') },
      },
    } as Partial<UsageReport>),
  }];
  const dist = getModelDistribution(stored);
  assert.equal(dist.length, 2);
  assert.ok(dist.some((d) => d.model === '__proto__'));
  assert.equal(({} as any).input, undefined, 'Object.prototype must be untouched');
});

test('a report spanning two months is split between them, not dumped into the first', () => {
  const stored: StoredReport[] = [{
    id: 'span', savedAt: '2026-10-01T00:00:00.000Z', name: 'span',
    report: report({
      period: { start: at(2026, 9, 30), end: at(2026, 10, 2) },
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
    report: report({ period: { start: at(2026, 10, 1), end: at(2026, 10, 5) }, usage: { ...MOCK_DATA.usage, tokens: { input: 300, output: 0, by_model: { 'claude-opus-5-5': { input: 300, output: 0 } } }, messages: { count: 3, by_day: [day('2026-10-01'), day('2026-10-02'), day('2026-10-03')] } } } as Partial<UsageReport>),
  };
  const newer: StoredReport = {
    id: 'new', savedAt: '2026-10-09T00:00:00.000Z', name: 'new',
    report: report({ period: { start: at(2026, 10, 1), end: at(2026, 10, 9) }, usage: { ...MOCK_DATA.usage, tokens: { input: 900, output: 0, by_model: { 'claude-opus-5-5': { input: 900, output: 0 } } }, messages: { count: 9, by_day: [1,2,3,4,5,6,7,8,9].map(n => day('2026-10-0' + n)) } } } as Partial<UsageReport>),
  };
  assert.deepEqual(pickNonOverlapping([older, newer]).map(s => s.id), ['new']);
  const totals = calculateMonthlyTrends([older, newer]);
  assert.equal(totals[0].messageCount, 9, 'nine days, each once');
  assert.equal(getModelDistribution([older, newer])[0].tokens, 900);
});


// ---- Every price, written out ----
// Literal numbers from Anthropic's pricing page, so a change to the table or its multipliers is noticed.
// Columns: input, output, cache read, 5-minute cache write, 1-hour cache write (USD per 1M tokens).
const GOLDEN: Array<[string, number, number, number, number, number]> = [
  ['claude-fable-5-1', 10, 50, 0.25, 12.5, 20],
  ['claude-fable-5', 10, 50, 1, 12.5, 20],
  ['claude-mythos-5-1', 10, 50, 0.25, 12.5, 20],
  ['claude-mythos-5', 10, 50, 1, 12.5, 20],
  ['claude-opus-5-5', 4, 20, 0.2, 5, 8],
  ['claude-opus-5', 5, 25, 0.5, 6.25, 10],
  ['claude-opus-4-8', 5, 25, 0.5, 6.25, 10],
  ['claude-opus-4-7', 5, 25, 0.5, 6.25, 10],
  ['claude-opus-4-6', 5, 25, 0.5, 6.25, 10],
  ['claude-opus-4-5', 5, 25, 0.5, 6.25, 10],
  ['claude-opus-4-1', 15, 75, 1.5, 18.75, 30],
  ['claude-opus-4', 15, 75, 1.5, 18.75, 30],
  ['claude-sonnet-5-5', 2, 10, 0.1, 2.5, 4],
  ['claude-sonnet-5', 2, 10, 0.2, 2.5, 4],
  ['claude-sonnet-4-6', 3, 15, 0.3, 3.75, 6],
  ['claude-sonnet-4-5', 3, 15, 0.3, 3.75, 6],
  ['claude-sonnet-4', 3, 15, 0.3, 3.75, 6],
  ['claude-haiku-5-5', 0.1, 0.5, 0.01, 0.125, 0.2],
  ['claude-haiku-5-5-long-prompt', 0.5, 2.5, 0.05, 0.625, 1],
  ['claude-haiku-4-5', 1, 5, 0.1, 1.25, 2],
  ['claude-3-5-haiku', 0.8, 4, 0.08, 1, 1.6],
  // OpenAI, from developers.openai.com/api/docs/pricing (2026-10-10). Cache read = "cached input". Where the page lists
  // no cached price, cached tokens cost full input. Where it lists no cache-write price, writes cost input.
  ['gpt-6.1-sol', 2, 10, 0.1, 2.5, 2.5],
  ['gpt-6.1-sol-long-prompt', 4, 15, 0.2, 5, 5],
  ['gpt-6-astra', 10, 50, 1, 12.5, 12.5],
  ['gpt-6-astra-long-prompt', 20, 75, 2, 25, 25],
  ['gpt-6-sol', 2, 10, 0.2, 2.5, 2.5],
  ['gpt-6-sol-long-prompt', 4, 15, 0.4, 5, 5],
  ['gpt-6-luna', 0.1, 0.5, 0.01, 0.125, 0.125],
  ['gpt-6-luna-long-prompt', 0.2, 0.75, 0.02, 0.25, 0.25],
  ['gpt-5.6-sol', 4, 20, 0.4, 5, 5],
  ['gpt-5.6-sol-long-prompt', 8, 30, 0.8, 10, 10],
  ['gpt-5.6-terra', 2, 12, 0.2, 2.5, 2.5],
  ['gpt-5.6-terra-long-prompt', 4, 18, 0.4, 5, 5],
  ['gpt-5.6-luna', 0.2, 1.2, 0.02, 0.25, 0.25],
  ['gpt-5.6-luna-long-prompt', 0.4, 1.8, 0.04, 0.5, 0.5],
  ['gpt-5.6-cyber', 12.5, 75, 1.25, 15.625, 15.625],
  ['gpt-5.5', 5, 30, 0.5, 5, 5],
  ['gpt-5.5-long-prompt', 10, 45, 1, 10, 10],
  ['gpt-5.5-pro', 30, 180, 30, 30, 30],
  ['gpt-5.5-pro-long-prompt', 60, 270, 60, 60, 60],
  ['gpt-5.5-cyber', 12.5, 75, 1.25, 12.5, 12.5],
  ['gpt-5.4', 2.5, 15, 0.25, 2.5, 2.5],
  ['gpt-5.4-long-prompt', 5, 22.5, 0.5, 5, 5],
  ['gpt-5.4-mini', 0.75, 4.5, 0.075, 0.75, 0.75],
  ['gpt-5.4-nano', 0.2, 1.25, 0.02, 0.2, 0.2],
  ['gpt-5.4-pro', 30, 180, 30, 30, 30],
  ['gpt-5.4-pro-long-prompt', 60, 270, 60, 60, 60],
  ['gpt-5.3-codex', 1.75, 14, 0.175, 1.75, 1.75],
  ['gpt-5.2', 1.75, 14, 0.175, 1.75, 1.75],
  ['gpt-5.2-pro', 21, 168, 21, 21, 21],
  ['gpt-5.2-codex', 1.75, 14, 0.175, 1.75, 1.75],
  ['gpt-5.1-codex-max', 1.25, 10, 0.125, 1.25, 1.25],
  ['gpt-5.1-codex-mini', 0.25, 2, 0.025, 0.25, 0.25],
  ['gpt-5.1-codex', 1.25, 10, 0.125, 1.25, 1.25],
  ['gpt-5-codex', 1.25, 10, 0.125, 1.25, 1.25],
  ['codex-mini-latest', 1.5, 6, 0.375, 1.5, 1.5],
  ['gpt-5.1', 1.25, 10, 0.125, 1.25, 1.25],
  ['gpt-5', 1.25, 10, 0.125, 1.25, 1.25],
  ['gpt-5-mini', 0.25, 2, 0.025, 0.25, 0.25],
  ['gpt-5-nano', 0.05, 0.4, 0.005, 0.05, 0.05],
  ['gpt-5-pro', 15, 120, 15, 15, 15],
  ['gpt-4.1', 2, 8, 0.5, 2, 2],
  ['gpt-4.1-mini', 0.4, 1.6, 0.1, 0.4, 0.4],
  ['gpt-4.1-nano', 0.1, 0.4, 0.025, 0.1, 0.1],
  ['gpt-4o', 2.5, 10, 1.25, 2.5, 2.5],
  ['gpt-4o-2024-05-13', 5, 15, 5, 5, 5],
  ['gpt-4o-mini', 0.15, 0.6, 0.075, 0.15, 0.15],
  ['o3-pro', 20, 80, 20, 20, 20],
  ['o3', 2, 8, 0.5, 2, 2],
  ['o4-mini', 1.1, 4.4, 0.275, 1.1, 1.1],
  ['o3-mini', 1.1, 4.4, 0.55, 1.1, 1.1],
  ['o1', 15, 60, 7.5, 15, 15],
  ['o1-pro', 150, 600, 150, 150, 150],
  // Google, from ai.google.dev/gemini-api/docs/pricing (paid tier, 2026-10-10). Cache read = context-caching price.
  ['gemini-3.8-flash', 0.75, 3.75, 0.075, 0.75, 0.75],
  ['gemini-3.6-flash', 0.75, 3.75, 0.075, 0.75, 0.75],
  ['gemini-3.8-flash-from-2027', 1.5, 7.5, 0.15, 1.5, 1.5],
  ['gemini-3.6-flash-from-2027', 1.5, 7.5, 0.15, 1.5, 1.5],
  ['gemini-3.5-flash-lite', 0.3, 2.5, 0.03, 0.3, 0.3],
  ['gemini-3.1-flash-lite', 0.25, 1.5, 0.025, 0.25, 0.25],
  ['gemini-3.1-pro-preview-customtools', 2, 12, 0.2, 2, 2],
  ['gemini-3.1-pro-preview-customtools-long-prompt', 4, 18, 0.4, 4, 4],
  ['gemini-3.1-pro-preview', 2, 12, 0.2, 2, 2],
  ['gemini-3.1-pro-preview-long-prompt', 4, 18, 0.4, 4, 4],
  ['gemini-3-flash-preview', 0.5, 3, 0.05, 0.5, 0.5],
  ['gemini-2.5-pro', 1.25, 10, 0.125, 1.25, 1.25],
  ['gemini-2.5-pro-long-prompt', 2.5, 15, 0.25, 2.5, 2.5],
  ['gemini-2.5-flash', 0.3, 2.5, 0.03, 0.3, 0.3],
  ['gemini-2.5-flash-lite', 0.1, 0.4, 0.01, 0.1, 0.1],
];
const near = (a: number, b: number) => Math.abs(a - b) < 1e-9;

test('the price table matches the published prices for every model', () => {
  for (const [model, input, output, read, write5m, write1h] of GOLDEN) {
    const p = priceFor(model);
    assert.ok(p, `${model} must be priced`);
    assert.ok(near(p.input, input), `${model} input ${p.input} should be ${input}`);
    assert.ok(near(p.output, output), `${model} output ${p.output} should be ${output}`);
    assert.ok(near(p.cacheRead, read), `${model} cache read ${p.cacheRead} should be ${read}`);
    assert.ok(near(p.cacheWrite, write5m), `${model} 5-minute write ${p.cacheWrite} should be ${write5m}`);
    assert.ok(near(p.cacheWrite1h, write1h), `${model} 1-hour write ${p.cacheWrite1h} should be ${write1h}`);
  }
});

test('each kind of token is charged at its own rate', () => {
  const one = 1_000_000;
  const cost = (t: Parameters<typeof tokenCost>[1]) => tokenCost('claude-sonnet-5-5', t).cost;
  assert.ok(near(cost({ input: one, output: 0 }), 2));
  assert.ok(near(cost({ input: 0, output: one }), 10));
  assert.ok(near(cost({ input: 0, output: 0, cache_read: one }), 0.1));
  assert.ok(near(cost({ input: 0, output: 0, cache_write: one }), 2.5));
  assert.ok(near(cost({ input: 0, output: 0, cache_write_1h: one }), 4));
});

test('every model in the price table has a row above, so a new price cannot slip in unchecked', () => {
  const source = readFileSync('services/pricing.ts', 'utf8');
  const table = source.slice(source.indexOf('const PRICES: Record'), source.indexOf('// A model id is a table key'));
  const keys = [...table.matchAll(/^\s+'([^']+)':/gm)].map((m) => m[1]).sort();
  assert.deepEqual(keys, GOLDEN.map(([model]) => model).sort());
});

// ---- The answer's edges ----

test('a plan and pay-as-you-go within a dollar (or 5% of the plan price) are a tie', () => {
  // 340,000 Sonnet 5.5 input tokens on one day = $20.40 a month, against Pro at $20
  const cmp = calculateAnalysis(oneDay({ tokens: 340_000 }), 'Claude Pro');
  assert.ok(near(cmp.apiCostMonthly, 20.4));
  assert.equal(cmp.verdict, 'tie');
  assert.equal(calculateAnalysis(oneDay({ tokens: 400_000 }), 'Claude Pro').verdict, 'keep');   // $24
  assert.equal(calculateAnalysis(oneDay({ tokens: 200_000 }), 'Claude Pro').verdict, 'switch'); // $12
});

test('under 7 days of data is flagged as an early guess; 7 days is not', () => {
  assert.equal(calculateAnalysis(oneDay({ tokens: 1_000_000, days: 6 }), 'Claude Pro').lowConfidence, true);
  assert.equal(calculateAnalysis(oneDay({ tokens: 1_000_000, days: 7 }), 'Claude Pro').lowConfidence, false);
});

test('replies cut short in the log make the cost a minimum, and a minimum cannot say "switch"', () => {
  // 100 replies, 30 never finished. Pay-as-you-go looks like $12 against Pro's $20.
  const cut = oneDay({ tokens: 200_000, replies: 100, unfinished: 30 });
  const cmp = calculateAnalysis(cut, 'Claude Pro');
  assert.equal(cmp.lowerBound, true);
  assert.equal(cmp.verdict, 'unknown');
  // The same numbers with every reply finished are a real estimate
  assert.equal(calculateAnalysis(oneDay({ tokens: 200_000, replies: 100, unfinished: 0 }), 'Claude Pro').verdict, 'switch');
});

test('a calendar span does not change across a clock change', () => {
  assert.equal(spanDays(at(2026, 3, 7, 12), at(2026, 3, 9, 12)), 3);     // US clocks go forward on Mar 8
  assert.equal(spanDays(at(2026, 10, 31, 12), at(2026, 11, 2, 12)), 3);  // and back on Nov 1
  assert.equal(spanDays('not a date', 'also not'), 1);
});

test('a usage pattern with no days has no peak and an average of zero', () => {
  const p = analyzeUsagePattern(report({ usage: { ...MOCK_DATA.usage, messages: { count: 0, by_day: [] } } } as Partial<UsageReport>));
  assert.equal(p.activeDays, 0);
  assert.equal(p.avgPerActiveDay, 0);
  assert.equal(p.peakDay, null);
});

// ---- Trends ----

test('month over month is shown only when the latest month has 20 active days', () => {
  const september = storedReport('sep', daysOf('2026-09', 30), '2026-10-01T00:00:00.000Z');
  const short = analyzeUsageTrends([september, storedReport('oct', daysOf('2026-10', 19), '2026-10-30T00:00:00.000Z')]);
  assert.equal(short?.percentChange, null);
  const enough = analyzeUsageTrends([september, storedReport('oct', daysOf('2026-10', 20), '2026-10-30T00:00:00.000Z')]);
  // September cost 30 x $0.002 = $0.06. October 20 x $0.002 = $0.04. That is a third less.
  assert.ok(enough?.percentChange !== null && enough !== null && Math.abs((enough.percentChange as number) + 100 / 3) < 1e-6);
  assert.equal(enough?.reportsUsed, 2);
  assert.equal(enough?.hasUnpriced, false);
});

test('trends say when some usage has no price', () => {
  const stored = storedReport('x', daysOf('2026-10', 3), '2026-10-04T00:00:00.000Z');
  stored.report.usage.tokens.by_model['claude-mystery-9'] = { input: 500, output: 0 };
  assert.equal(analyzeUsageTrends([stored])?.hasUnpriced, true);
});

test('the weekday chart uses the calendar day, whatever the time zone', () => {
  // 2026-10-09 is a Friday
  const stored = storedReport('fri', ['2026-10-09'], '2026-10-10T00:00:00.000Z');
  const friday = getWeekdayHeatmap([stored]).find((d) => d.day === 'Friday');
  assert.equal(friday?.avgTokens, 1000);
  assert.equal(getWeekdayHeatmap([stored]).filter((d) => d.avgTokens > 0).length, 1);
});

test('the daily breakdown is sorted by date and spreads the cost by token share', () => {
  const stored = storedReport('d', ['2026-10-03', '2026-10-01', '2026-10-02'], '2026-10-04T00:00:00.000Z');
  const days = getDailyBreakdown([stored]);
  assert.deepEqual(days.map((d) => d.date), ['2026-10-01', '2026-10-02', '2026-10-03']);
  assert.ok(near(days[0].cost, 0.002));
});

test('month names are written out for the chart', () => {
  assert.equal(formatMonth('2026-10'), 'Oct 2026');
});

test('an unpriced model cannot hide behind a pile of cheap cache reads', () => {
  // The priced model has 40M cache-read tokens, which cost little. The unpriced model has 1.4M tokens that could cost a lot.
  const r = report({
    period: { start: at(2026, 9, 1), end: at(2026, 9, 30) },
    usage: {
      tokens: {
        input: 3_000_000, output: 800_000,
        by_model: {
          'claude-sonnet-5-5': { input: 2_000_000, output: 400_000, cache_read: 40_000_000 },
          'claude-opus-5-6': { input: 1_000_000, output: 400_000 },
        },
      },
      messages: { count: 500, by_day: [{ date: '2026-09-10', count: 500, input: 3_000_000, output: 800_000 }] },
      sessions: { count: 5 },
    },
  } as Partial<UsageReport>);
  const cmp = calculateAnalysis(r, 'Claude Pro');
  assert.ok(cmp.apiCostMonthly < 20, 'the priced part alone is below the plan price');
  assert.equal(cmp.lowerBound, true);
  assert.notEqual(cmp.verdict, 'switch', 'it must never claim pay-as-you-go is cheaper');
  assert.equal(cmp.verdict, 'unknown');
});
