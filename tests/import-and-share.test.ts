import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseUsageFile, convertClaudeExport, ESTIMATED_MODEL, MAX_FILE_BYTES } from '../services/fileImport.ts';
import { buildAiQuestion, buildShareLine } from '../services/shareService.ts';
import { calculateAnalysis, analyzeUsagePattern } from '../services/analysisService.ts';
import { MOCK_DATA } from '../constants.ts';

const text = (v: unknown) => JSON.stringify(v);

test('a CLI usage report loads as it is', () => {
  const r = parseUsageFile(text(MOCK_DATA), 1000, 'Claude Pro');
  assert.equal(r.ok, true);
  assert.equal(r.ok && r.report.plan.name, MOCK_DATA.plan.name);
});

test('a file that is not JSON gets a plain message', () => {
  const r = parseUsageFile('not json', 8, 'Claude Pro');
  assert.equal(r.ok, false);
  assert.match(!r.ok ? r.error : '', /valid JSON/);
});

test('a file over the size limit is refused before it is parsed', () => {
  const r = parseUsageFile('[]', MAX_FILE_BYTES + 1, 'Claude Pro');
  assert.equal(r.ok, false);
  assert.match(!r.ok ? r.error : '', /50 MB/);
});

test('JSON of the wrong shape is refused, and a report with a text token count is too', () => {
  assert.equal(parseUsageFile(text({ hello: 'world' }), 20, 'Claude Pro').ok, false);
  const bad = JSON.parse(text(MOCK_DATA));
  bad.usage.tokens.input = '1000';
  assert.equal(parseUsageFile(text(bad), 100, 'Claude Pro').ok, false);
});

const exportFile = [{
  uuid: 'c1',
  created_at: '2026-10-02T10:00:00',
  chat_messages: [
    { sender: 'human', text: 'a'.repeat(400) },
    { sender: 'assistant', text: 'b'.repeat(800) },
    { sender: 'assistant', text: 'c'.repeat(40) },
  ],
}];

test('a claude.ai export counts each assistant message once and estimates tokens at 4 characters each', () => {
  const r = parseUsageFile(text(exportFile), 500, 'Claude Pro');
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.report.usage.messages.count, 2);
  assert.equal(r.report.usage.tokens.input, 100);
  assert.equal(r.report.usage.tokens.output, 210);
  assert.ok(ESTIMATED_MODEL in r.report.usage.tokens.by_model);
});

test('a claude.ai export with no messages says so', () => {
  const r = parseUsageFile(text([{ uuid: 'x', created_at: '2026-10-02T10:00:00', chat_messages: [] }]), 100, 'Claude Pro');
  assert.equal(r.ok, false);
  assert.match(!r.ok ? r.error : '', /no messages/);
});

test('a claude.ai export is not given a price, because it does not say which model answered', () => {
  const report = convertClaudeExport(exportFile, 'Claude Pro');
  const cmp = calculateAnalysis(report, 'Claude Pro');
  assert.equal(cmp.apiCostMonthly, 0);
});

test('the AI question holds numbers and plan names only', () => {
  const cmp = calculateAnalysis(MOCK_DATA, 'Claude Pro');
  const q = buildAiQuestion(MOCK_DATA, cmp, analyzeUsagePattern(MOCK_DATA));
  assert.match(q, /My plan: Claude Pro/);
  assert.match(q, /per month/);
  assert.ok(!q.includes('http'), 'no links in the question');
});

test('the share line states what the numbers are and links the project', () => {
  const cmp = calculateAnalysis(MOCK_DATA, 'Claude Pro');
  const line = buildShareLine(cmp);
  assert.match(line, /list prices/);
  assert.match(line, /github\.com\/beastllama\/llm-usage-analyzer/);
  assert.ok(!line.includes('\n'));
});
