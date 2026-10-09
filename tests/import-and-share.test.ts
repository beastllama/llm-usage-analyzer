import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseUsageFile, convertClaudeExport, isUsageReport, ESTIMATED_MODEL, MAX_FILE_BYTES } from '../services/fileImport.ts';
import { buildAiQuestion, buildShareLine } from '../services/shareService.ts';
import { calculateAnalysis, analyzeUsagePattern } from '../services/analysisService.ts';
import { MOCK_DATA } from '../constants.ts';
import { clone, oneDay } from './helpers.ts';

const text = (v: unknown) => JSON.stringify(v);

test('a CLI usage report loads as it is', () => {
  const r = parseUsageFile(text(MOCK_DATA), 1000, 'Claude Pro');
  assert.equal(r.ok, true);
  assert.equal(r.ok && r.report.plan.name, MOCK_DATA.plan.name);
});

test('a file that is not JSON gets a plain message', () => {
  const r = parseUsageFile('not json', 8, 'Claude Pro');
  assert.equal(r.ok, false);
  assert.match(!r.ok ? r.error : '', /can't read that file/);
});

test('a file over the size limit is refused before it is parsed', () => {
  const r = parseUsageFile('[]', MAX_FILE_BYTES + 1, 'Claude Pro');
  assert.equal(r.ok, false);
  assert.match(!r.ok ? r.error : '', /50 MB/);
});

test('a ZIP file is recognised, and the message says what to do', () => {
  const r = parseUsageFile('PK\u0003\u0004binary', 12, 'Claude Pro');
  assert.equal(r.ok, false);
  assert.match(!r.ok ? r.error : '', /ZIP/);
  assert.match(!r.ok ? r.error : '', /conversations\.json/);
});

test('JSON of the wrong shape is refused', () => {
  assert.equal(parseUsageFile(text({ hello: 'world' }), 20, 'Claude Pro').ok, false);
  assert.equal(parseUsageFile('null', 4, 'Claude Pro').ok, false);
  assert.equal(parseUsageFile('42', 2, 'Claude Pro').ok, false);
  assert.equal(parseUsageFile('[1, 2, 3]', 9, 'Claude Pro').ok, false);
});

// A report is read by the dashboard, the exports and the saved list, so a damaged one must be refused up front.
const damaged: Array<[string, (r: ReturnType<typeof clone<typeof MOCK_DATA>>) => void]> = [
  ['a token count written as text', (r) => { (r.usage.tokens as any).input = '1000'; }],
  ['a negative token count', (r) => { r.usage.tokens.output = -1; }],
  ['a model with a text count', (r) => { (r.usage.tokens.by_model['claude-sonnet-5-5'] as any).output = 'x'; }],
  ['a model with a negative cache count', (r) => { r.usage.tokens.by_model['claude-sonnet-5-5'].cache_read = -5; }],
  ['a missing model list', (r) => { delete (r.usage.tokens as any).by_model; }],
  ['a missing plan', (r) => { delete (r as any).plan; }],
  ['a plan with no price', (r) => { (r.plan as any).price_usd = 'free'; }],
  ['a plan with no name', (r) => { delete (r.plan as any).name; }],
  ['a period that is not a date', (r) => { r.period.start = 'soon'; }],
  ['a day written the wrong way', (r) => { r.usage.messages.by_day[0].date = '1/9/2026'; }],
  ['a day with a text count', (r) => { (r.usage.messages.by_day[0] as any).count = '5'; }],
  ['a day that is null', (r) => { (r.usage.messages.by_day as any)[0] = null; }],
  ['days that are not a list', (r) => { (r.usage.messages as any).by_day = {}; }],
  ['a negative reply count', (r) => { r.usage.messages.count = -3; }],
  ['a text unfinished count', (r) => { (r.usage.messages as any).unfinished = 'many'; }],
  ['no sessions', (r) => { delete (r.usage as any).sessions; }],
  ['no provider', (r) => { delete (r as any).provider; }],
];
for (const [name, damage] of damaged) {
  test(`a report with ${name} is refused`, () => {
    const bad = clone(MOCK_DATA);
    damage(bad);
    assert.equal(isUsageReport(bad), false);
    assert.equal(parseUsageFile(text(bad), 100, 'Claude Pro').ok, false);
  });
}

test('a report from an older scan, with no unfinished count and no cache split, still loads', () => {
  const old = clone(MOCK_DATA);
  delete (old.usage.messages as any).unfinished;
  delete (old.usage.tokens as any).cached;
  assert.equal(isUsageReport(old), true);
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

test('an export that keeps message text in a content list is read too', () => {
  const file = [{
    uuid: 'c2',
    created_at: '2026-10-02T10:00:00',
    chat_messages: [
      { sender: 'human', content: [{ type: 'text', text: 'a'.repeat(400) }] },
      { sender: 'assistant', content: [{ type: 'text', text: 'b'.repeat(400) }, { type: 'tool_use', name: 'x' }, { type: 'text', text: 'c'.repeat(400) }] },
    ],
  }];
  const r = parseUsageFile(text(file), 500, 'Claude Pro');
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.report.usage.tokens.input, 100);
  assert.equal(r.report.usage.tokens.output, 201, 'two blocks of 400 characters and a line break between them');
});

test('each message in an export goes on the day it was written', () => {
  const file = [{
    uuid: 'c3',
    created_at: '2026-10-01T09:00:00',
    chat_messages: [
      { sender: 'human', text: 'hello', created_at: '2026-10-01T09:00:00' },
      { sender: 'assistant', text: 'hi there', created_at: '2026-10-01T09:00:05' },
      { sender: 'human', text: 'one more thing', created_at: '2026-10-04T12:00:00' },
      { sender: 'assistant', text: 'sure', created_at: '2026-10-04T12:00:09' },
    ],
  }];
  const report = convertClaudeExport(file, 'Claude Pro');
  assert.deepEqual(report.usage.messages.by_day.map((d) => [d.date, d.count]), [['2026-10-01', 1], ['2026-10-04', 1]]);
  assert.equal(report.usage.sessions.count, 1);
});

test('messages from someone else, or with no date at all, do not break an export', () => {
  const file = [
    { uuid: 'c4', chat_messages: [{ sender: 'system', text: 'x'.repeat(100) }, { sender: 'assistant', text: 'ok' }, null, 'junk'] },
    'not a conversation',
    null,
  ];
  const r = parseUsageFile(text(file), 200, 'Claude Pro');
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.report.usage.messages.count, 1);
  assert.deepEqual(r.report.usage.messages.by_day, [], 'no date, so no day row');
});

test('a claude.ai export with no messages says so', () => {
  const r = parseUsageFile(text([{ uuid: 'x', created_at: '2026-10-02T10:00:00', chat_messages: [] }]), 100, 'Claude Pro');
  assert.equal(r.ok, false);
  assert.match(!r.ok ? r.error : '', /No chats/);
});

test('a claude.ai export is not given a price, because it does not say which model answered', () => {
  const report = convertClaudeExport(exportFile, 'Claude Pro');
  const cmp = calculateAnalysis(report, 'Claude Pro');
  assert.equal(cmp.apiCostMonthly, 0);
  assert.equal(cmp.canJudge, false);
});

test('the AI question holds numbers and plan names only', () => {
  const cmp = calculateAnalysis(MOCK_DATA, 'Claude Pro');
  const q = buildAiQuestion(MOCK_DATA, cmp, analyzeUsagePattern(MOCK_DATA));
  assert.match(q, /My plan: Claude Pro/);
  assert.match(q, /per month/);
  assert.ok(!q.includes('http'), 'no links in the question');
});

test('the AI question says when the cost is only a minimum', () => {
  const cut = oneDay({ tokens: 200_000, replies: 100, unfinished: 40 });
  const q = buildAiQuestion(cut, calculateAnalysis(cut, 'Claude Pro'), analyzeUsagePattern(cut));
  assert.match(q, /at least about/);
  assert.match(q, /Note: 40% of your replies were logged before they finished/);
});

test('the share line states what the numbers are and links the project', () => {
  const cmp = calculateAnalysis(oneDay({ tokens: 400_000 }), 'Claude Pro'); // $24 a month against $20
  const line = buildShareLine(cmp);
  assert.ok(line);
  assert.match(line, /looks cheaper than pay-as-you-go/);
  assert.match(line, /estimate/);
  assert.match(line, /github\.com\/beastllama\/llm-usage-analyzer/);
  assert.ok(!line.includes('\n'));
});

test('the share line follows the answer: switch, tie, and nothing at all when there is no answer', () => {
  const sw = buildShareLine(calculateAnalysis(oneDay({ tokens: 200_000 }), 'Claude Pro'));
  assert.match(sw ?? '', /Pay-as-you-go looks cheaper than my Claude Pro plan/);
  const tie = buildShareLine(calculateAnalysis(oneDay({ tokens: 340_000 }), 'Claude Pro'));
  assert.match(tie ?? '', /about the same/);
  // Cut-short replies and a plan above the minimum: no honest answer, so nothing to share
  const unknown = buildShareLine(calculateAnalysis(oneDay({ tokens: 200_000, replies: 100, unfinished: 50 }), 'Claude Pro'));
  assert.equal(unknown, null);
});

test('a share line for a minimum says "at least"', () => {
  const cmp = calculateAnalysis(oneDay({ tokens: 400_000, replies: 100, unfinished: 50 }), 'Claude Pro');
  assert.equal(cmp.verdict, 'keep');
  assert.match(buildShareLine(cmp) ?? '', /at least about/);
});
