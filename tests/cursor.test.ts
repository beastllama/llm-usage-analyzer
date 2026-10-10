// Cursor's usage CSV. The sample (tests/fixtures/cursor-usage.csv) has the column layout of real exports from 2026.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseCursorCsv, looksLikeCursorCsv } from '../services/cursorImport.ts';
import { parseUsageFile, isUsageReport } from '../services/fileImport.ts';
import { calculateAnalysis } from '../services/analysisService.ts';
import { describeAnswer } from '../services/answer.ts';

const SAMPLE = readFileSync('tests/fixtures/cursor-usage.csv', 'utf8');

test('a Cursor export is read: four separate token amounts per row, and failed requests left out', () => {
  const r = parseCursorCsv(SAMPLE);
  assert.ok(r.ok);
  const { report } = r;
  assert.ok(isUsageReport(report));
  assert.equal(report.product, 'cursor');
  assert.equal(report.tool, 'Cursor');
  assert.equal(r.skipped, 1, 'the "Errored, No Charge" row');
  assert.equal(report.usage.messages.count, 5);
  assert.equal(report.usage.tokens.input, 48213 + 35870 + 51377 + 96214 + 775);
  assert.equal(report.usage.tokens.output, 3917 + 5236 + 9902 + 18375 + 21282);
  assert.deepEqual(report.usage.tokens.by_model['composer-2.5'], {
    input: 35870 + 51377, output: 5236 + 9902, cache_read: 401152 + 1384320, cache_write: 2210,
  });
  assert.equal(report.usage.messages.by_day.reduce((sum, d) => sum + d.count, 0), 5);
});

test('the file drop recognises a Cursor CSV', () => {
  assert.ok(looksLikeCursorCsv(SAMPLE));
  assert.ok(looksLikeCursorCsv('﻿' + SAMPLE), 'with a byte-order mark too');
  const r = parseUsageFile(SAMPLE, SAMPLE.length);
  assert.ok(r.ok);
  assert.equal(r.reports[0].product, 'cursor');
});

test('an older export without the agent columns is read by column name', () => {
  const old = [
    'Date,Kind,Model,Max Mode,Input (w/ Cache Write),Input (w/o Cache Write),Cache Read,Output Tokens,Total Tokens,Cost',
    '"2025-11-28T11:07:39.733Z","Included","composer-1","No","91759","0","580160","5619","677538","0.26"',
  ].join('\n');
  const r = parseCursorCsv(old);
  assert.ok(r.ok);
  assert.equal(r.report.usage.tokens.by_model['composer-1'].cache_write, 91759);
});

test('a CSV that is not a Cursor export is turned away', () => {
  const r = parseUsageFile('name,amount\n"a","1"', 20);
  assert.equal(r.ok, false);
});

test('a row with a damaged number is left out, and the totals are then only a minimum', () => {
  const damaged = SAMPLE.replace('"48213"', '"48,2x3"');
  const r = parseCursorCsv(damaged);
  assert.ok(r.ok);
  assert.equal(r.report.usage.messages.count, 4);
  assert.equal(r.report.usage.incomplete, true);
});

test('"auto" names no model, so it is not priced, and the cost is a minimum', () => {
  const r = parseCursorCsv(SAMPLE);
  assert.ok(r.ok);
  const cmp = calculateAnalysis(r.report);
  assert.equal(cmp.planKey, 'Cursor Pro');
  assert.ok(cmp.unpricedModels.includes('auto'));
  assert.ok(!cmp.unpricedModels.includes('composer-2.5'), "Cursor publishes Composer 2.5's price");
  assert.equal(cmp.lowerBound, true);
  assert.ok(describeAnswer(cmp).caveats.some((c) => /no price for/.test(c)));
});
