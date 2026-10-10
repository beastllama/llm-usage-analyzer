// Several tools at once: the overview's headline and totals, files with several reports, Trends per product,
// saved reports from before tools were named, Cursor's on-demand charges, and exports of reports with no plan.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { overviewRows, overviewTotals } from '../services/overview.ts';
import { isUsageBundle, parseUsageFile, BUNDLE_FORMAT } from '../services/fileImport.ts';
import { trendProducts, calculateMonthlyTrends } from '../services/trendService.ts';
import { storageService } from '../services/storageService.ts';
import { parseCursorCsv } from '../services/cursorImport.ts';
import { calculateAnalysis } from '../services/analysisService.ts';
import { describeAnswer } from '../services/answer.ts';
import { generateCSV } from '../services/exportService.ts';
import type { UsageReport } from '../types.ts';
import { oneDay, storedReport, daysOf } from './helpers.ts';

/** One day of use: `tokens` input tokens of `model`, counted against `product`. */
const day = (product: UsageReport['product'], tool: string, model: string, tokens: number, provider: UsageReport['provider'] = 'anthropic'): UsageReport =>
  ({ ...oneDay({ tokens, model }), product, tool, provider });

// Claude: 1M Sonnet 5.5 input tokens a day = $60 a month against Pro at $20 (keep)
const claudeKeep = day('claude', 'Claude Code', 'claude-sonnet-5-5', 1_000_000);
// Codex: 100K gpt-6.1-sol input tokens a day = $6 a month against Plus at $20 (switch)
const codexSwitch = day('chatgpt', 'Codex CLI', 'gpt-6.1-sol', 100_000, 'openai');
// Codex: 4M a day = $240 a month (keep)
const codexKeep = day('chatgpt', 'Codex CLI', 'gpt-6.1-sol', 4_000_000, 'openai');
// Gemini: 1M gemini-2.5-pro input tokens a day = $37.50 a month, pay-as-you-go
const gemini = day('gemini-api', 'Gemini CLI', 'gemini-2.5-pro', 1_000_000, 'google');

test('the overview gives one verdict only when every plan gets the same one', () => {
  const same = overviewTotals(overviewRows([claudeKeep, codexKeep], {}));
  assert.equal(same.headline, 'Your plans cost less than pay-as-you-go.');
  const mixed = overviewTotals(overviewRows([claudeKeep, codexSwitch], {}));
  assert.match(mixed.headline, /different for each tool/);
  assert.match(mixed.lines[0], /Your 2 plans \(some assumed\) cost \$40\.00 a month/);
});

test('the overview names the pay-as-you-go tool, and only calls every tool pay-as-you-go when that is true', () => {
  const unpriced = day('claude', 'Claude Code', 'claude-opus-9', 1000);
  const t = overviewTotals(overviewRows([unpriced, gemini], {}));
  assert.equal(t.headline, 'Gemini CLI is pay-as-you-go.');
  const both = overviewTotals(overviewRows([claudeKeep, gemini], {}));
  assert.ok(both.lines.some((l) => /Gemini CLI is pay-as-you-go: about \$38 a month/.test(l)));
  assert.ok(both.lines.some((l) => /All together, about \$58 a month/.test(l)), 'plan $20 plus Gemini about $37.50');
});

test('two tools on the same product count its plan once', () => {
  const t = overviewTotals(overviewRows([claudeKeep, { ...claudeKeep, tool: 'claude.ai' }], { claude: 'Claude Pro' }));
  assert.match(t.lines[0], /Your plan cost \$20\.00 a month/);
  assert.equal(t.anyAssumed, false);
});

test('a file with several reports: at least one, at most twenty, and every one must be valid', () => {
  const bundle = (reports: unknown[]) => ({ format: BUNDLE_FORMAT, version: 1, reports });
  assert.ok(isUsageBundle(bundle([claudeKeep, gemini])));
  assert.equal(isUsageBundle(bundle([])), false);
  assert.equal(isUsageBundle(bundle(Array(21).fill(claudeKeep))), false);
  assert.equal(isUsageBundle(bundle([claudeKeep, { ...gemini, product: 'mystery' }])), false);
  const text = JSON.stringify(bundle([claudeKeep, gemini]));
  const r = parseUsageFile(text, text.length);
  assert.ok(r.ok);
  assert.equal(r.reports.length, 2);
});

test('Trends keep each product apart, so two tools on the same days both count', () => {
  const claude = storedReport('c', daysOf('2026-09', 30), '2026-10-01T00:00:00Z');
  const codex = storedReport('x', daysOf('2026-09', 30), '2026-10-02T00:00:00Z', { model: 'gpt-6.1-sol' });
  codex.report.product = 'chatgpt';
  codex.report.provider = 'openai';
  const all = [claude, codex];
  assert.deepEqual(trendProducts(all).sort(), ['chatgpt', 'claude']);
  assert.equal(calculateMonthlyTrends(all, 'claude')[0].messageCount, 30);
  assert.equal(calculateMonthlyTrends(all, 'chatgpt')[0].messageCount, 30);
});

// The app runs in a browser. A small stand-in for its storage.
class FakeStorage {
  private m = new Map<string, string>();
  getItem(k: string) { return this.m.get(k) ?? null; }
  setItem(k: string, v: string) { this.m.set(k, v); }
  removeItem(k: string) { this.m.delete(k); }
}
beforeEach(() => {
  (globalThis as { window?: unknown }).window = { localStorage: new FakeStorage(), sessionStorage: new FakeStorage() };
});

test('a report saved before tools were named is found as the same report again, not saved twice', () => {
  const { product: _p, tool: _t, ...old } = claudeKeep;
  storageService.saveReport(old as UsageReport);
  assert.ok(storageService.findDuplicateReport(claudeKeep));
  // A different tool on the same days is not the same report
  assert.equal(storageService.findDuplicateReport(codexKeep), undefined);
});

// ---- Cursor's on-demand charges

const SAMPLE = readFileSync('tests/fixtures/cursor-usage.csv', 'utf8');

test('Cursor: on-demand rows and their cost are read from the export, and counted as paid', () => {
  const r = parseCursorCsv(SAMPLE);
  assert.ok(r.ok);
  assert.deepEqual(r.report.usage.on_demand, { usd: 0.81, rows: 2, rows_without_cost: 0 });
});

test('Cursor: when the plan is used up, what Cursor billed on top is part of the comparison', () => {
  // 30 days of on-demand use, $3.25 a day, all of it priced (composer-2.5)
  const rows = Array.from({ length: 30 }, (_, i) =>
    `"2026-09-${String(i + 1).padStart(2, '0')}T12:00:00.000Z","","","On-Demand","composer-2.5","No","0","1000000","0","100000","1100000","3.25"`);
  const csv = ['Date,Cloud Agent ID,Automation ID,Kind,Model,Max Mode,Input (w/ Cache Write),Input (w/o Cache Write),Cache Read,Output Tokens,Total Tokens,Cost', ...rows].join('\n');
  const r = parseCursorCsv(csv);
  assert.ok(r.ok);
  const cmp = calculateAnalysis(r.report, 'Cursor Pro');
  // Paid: $20 plan + $97.50 on demand. Pay-as-you-go: 30 x (1M x $0.5 + 100K x $2.5) / 1M = $22.50
  assert.ok(Math.abs(cmp.paidMonthly - 117.5) < 0.5);
  assert.equal(cmp.verdict, 'switch', 'the plan did not save money: Cursor billed the extra use anyway');
  assert.match(describeAnswer(cmp).detail, /billed on demand|on-demand/);
});

test('Cursor: on-demand use with no cost in the export never shows the plan as cheaper', () => {
  const csv = SAMPLE.replace('"0.19"', '"-"');
  const r = parseCursorCsv(csv);
  assert.ok(r.ok);
  assert.equal(r.report.usage.on_demand?.rows_without_cost, 1);
  const cmp = calculateAnalysis(r.report, 'Cursor Pro');
  assert.notEqual(cmp.verdict, 'keep');
  assert.ok(describeAnswer(cmp).caveats.some((c) => /doesn't say how much/.test(c)));
});

test('Cursor: model labels like "constructor" or "__proto__" are just labels', () => {
  const header = SAMPLE.split('\n')[0];
  const csv = [header,
    '"2026-10-09T10:00:00.000Z","","","Included","constructor","No","0","100","0","10","110","Included"',
    '"2026-10-09T11:00:00.000Z","","","Included","__proto__","No","0","200","0","20","220","Included"',
  ].join('\n');
  const r = parseUsageFile(csv, csv.length);
  assert.ok(r.ok);
  const byModel = r.reports[0].usage.tokens.by_model;
  assert.equal(byModel['constructor'].input, 100);
  assert.equal(Object.prototype.hasOwnProperty.call(byModel, '__proto__'), true);
  assert.equal(typeof ({} as Record<string, unknown>).input, 'undefined', 'nothing leaked onto every object');
});

test('Cursor: a row dated before the export existed is not used', () => {
  const csv = SAMPLE.replace('"2026-10-08T21:15:09.447Z"', '"0099-01-01T00:00:00.000Z"');
  const r = parseCursorCsv(csv);
  assert.ok(r.ok);
  assert.equal(r.report.usage.messages.count, 4);
  assert.equal(r.report.usage.incomplete, true);
});

test('Cursor: long prompts are priced at their long-prompt rate, like in the command', () => {
  const header = SAMPLE.split('\n')[0];
  const csv = [header, '"2026-10-09T10:00:00.000Z","","","Included","gpt-5.4","Yes","0","300000","0","1000","301000","Included"'].join('\n');
  const r = parseCursorCsv(csv);
  assert.ok(r.ok);
  assert.ok(r.report.usage.tokens.by_model['gpt-5.4-long-prompt']);
});

// ---- Exports of reports with no plan

test('exports say "None" for the plan of a pay-as-you-go tool or an unknown product, never a Claude plan', () => {
  assert.match(generateCSV(gemini, ''), /^Plan,None \(pay-as-you-go\)$/m);
  const { product: _p, tool: _t, ...base } = oneDay({ tokens: 1000 });
  const unknown: UsageReport = { ...base, provider: 'xai' };
  assert.match(generateCSV(unknown, ''), /^Plan,None$/m);
});
