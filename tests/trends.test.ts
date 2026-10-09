import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeUsageTrends, calculateMonthlyTrends, getRecentDays, trendReports, hasPricedUsage } from '../services/trendService.ts';
import { convertClaudeExport } from '../services/fileImport.ts';
import { daysOf, storedReport } from './helpers.ts';
import type { StoredReport } from '../types.ts';

const SAVED = (n: number) => `2026-10-${String(n).padStart(2, '0')}T00:00:00.000Z`;

test('a month is compared with the one before only when both have 20 active days', () => {
  const full = storedReport('sep', daysOf('2026-09', 30), SAVED(1));
  const oct20 = storedReport('oct', daysOf('2026-10', 20), SAVED(2));
  assert.ok((analyzeUsageTrends([full, oct20])?.percentChange ?? null) !== null, 'two full months are compared');

  // The case from the review: the end of August (7 days) and a full September read as "+328%"
  const augEnd = storedReport('aug', daysOf('2026-08', 7, 25), SAVED(1));
  const sep = storedReport('sep2', daysOf('2026-09', 30), SAVED(2));
  assert.equal(analyzeUsageTrends([augEnd, sep])?.percentChange, null);

  // 19 days in the earlier month is still too few; 20 is enough
  const aug19 = storedReport('aug19', daysOf('2026-08', 19), SAVED(1));
  const aug20 = storedReport('aug20', daysOf('2026-08', 20), SAVED(1));
  const sep20 = storedReport('s20', daysOf('2026-09', 20), SAVED(2));
  assert.equal(analyzeUsageTrends([aug19, sep20])?.percentChange, null);
  assert.ok((analyzeUsageTrends([aug20, sep20])?.percentChange ?? null) !== null);
});

test('months that do not follow each other are not compared', () => {
  const june = storedReport('jun', daysOf('2026-06', 30), SAVED(1));
  const august = storedReport('aug', daysOf('2026-08', 30), SAVED(2));
  assert.equal(analyzeUsageTrends([june, august])?.percentChange, null);
});

test('a year change counts as the next month', () => {
  const dec = storedReport('dec', daysOf('2026-12', 25), '2027-01-02T00:00:00.000Z');
  const jan = storedReport('jan', daysOf('2027-01', 25), '2027-02-02T00:00:00.000Z');
  assert.ok((analyzeUsageTrends([dec, jan])?.percentChange ?? null) !== null);
});

test('Trends say "at least" when any report used is a minimum', () => {
  const plain = storedReport('a', daysOf('2026-09', 25), SAVED(1));
  assert.equal(analyzeUsageTrends([plain])?.lowerBound, false);
  // 60% of the replies were cut short in the log
  const cut = storedReport('b', daysOf('2026-10', 25), SAVED(2), { unfinished: 15 });
  assert.equal(analyzeUsageTrends([plain, cut])?.lowerBound, true);
  // or a model with no price
  const unpriced = storedReport('c', daysOf('2026-10', 25), SAVED(2));
  unpriced.report.usage.tokens.by_model['claude-mystery-9'] = { input: 5, output: 5 };
  assert.equal(analyzeUsageTrends([plain, unpriced])?.lowerBound, true);
});

test('a claude.ai chat export has no prices, so it is left out of Trends instead of hiding the priced report', () => {
  const priced = storedReport('cli', daysOf('2026-10', 5), SAVED(5));
  const exportReport = convertClaudeExport([{
    uuid: 'c1', created_at: '2026-10-02T10:00:00',
    chat_messages: [
      { sender: 'human', text: 'a'.repeat(400), created_at: '2026-10-02T10:00:00' },
      { sender: 'assistant', text: 'b'.repeat(800), created_at: '2026-10-02T10:00:05' },
    ],
  }]);
  // The export is newer and covers one of the same days
  const chat: StoredReport = { id: 'chat', savedAt: SAVED(9), name: 'chat', report: exportReport };

  assert.equal(hasPricedUsage(chat), false);
  assert.equal(hasPricedUsage(priced), true);
  assert.deepEqual(trendReports([priced, chat]).map((r) => r.id), ['cli']);

  const trends = analyzeUsageTrends([priced, chat]);
  assert.equal(trends?.reportsUsed, 1);
  assert.ok((trends?.projectedMonthlyCost ?? 0) > 0, 'the priced report still gives a cost');
  assert.equal(analyzeUsageTrends([chat]), null, 'only chat exports: nothing to show');
});

test('the last 30 days are 30 calendar days, with quiet days as zero', () => {
  // 40 active days spread over a long span: the old chart showed "the last 30 active days" (a span of months)
  const days = [...daysOf('2026-01', 10), ...daysOf('2026-03', 10), ...daysOf('2026-06', 10), ...daysOf('2026-09', 10, 10)];
  const rows = getRecentDays([storedReport('long', days, SAVED(1))], 30);
  assert.equal(rows.length, 30);
  assert.equal(rows[rows.length - 1].date, '2026-09-19');
  assert.equal(rows[0].date, '2026-08-21');
  assert.equal(rows.filter((r) => r.tokens > 0).length, 10, 'only the ten September days have activity');
  assert.equal(rows.filter((r) => r.tokens === 0).length, 20);
});

test('the last 30 days never reach back before the first day with data', () => {
  const rows = getRecentDays([storedReport('short', ['2026-10-03', '2026-10-05', '2026-10-08'], SAVED(9))], 30);
  assert.deepEqual(rows.map((r) => r.date), ['2026-10-03', '2026-10-04', '2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08']);
  assert.deepEqual(rows.map((r) => r.tokens), [1000, 0, 1000, 0, 0, 1000]);
  assert.deepEqual(getRecentDays([], 30), []);
});

test('the last 30 days do not lose a day in zones that change the clock at midnight', () => {
  const before = process.env.TZ;
  try {
    for (const tz of ['America/Santiago', 'Asia/Beirut', 'Africa/Cairo']) {
      process.env.TZ = tz;
      const rows = getRecentDays([storedReport('x', daysOf('2026-09', 30), SAVED(1))], 30);
      assert.equal(rows.length, 30, tz);
    }
  } finally {
    if (before === undefined) delete process.env.TZ; else process.env.TZ = before;
  }
});

test('monthly totals still split a report between its months', () => {
  const months = calculateMonthlyTrends([storedReport('two', ['2026-09-30', '2026-10-01', '2026-10-02'], SAVED(3))]);
  assert.deepEqual(months.map((m) => [m.period, m.activeDays]), [['2026-09', 1], ['2026-10', 2]]);
});
