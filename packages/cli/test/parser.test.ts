import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { scanClaudeUsage, localDayKey, parseLocalDate } from '../src/parsers/claude.ts';
import { addHistoryToReport } from '../src/history.ts';

let dir: string;
let previous: string | undefined;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-usage-test-'));
  fs.mkdirSync(path.join(dir, 'projects', 'proj-a'), { recursive: true });
  previous = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = dir;
});

afterEach(() => {
  if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = previous;
  fs.rmSync(dir, { recursive: true, force: true });
});

function writeTranscript(name: string, lines: unknown[]) {
  const text = lines.map(l => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n';
  fs.writeFileSync(path.join(dir, 'projects', 'proj-a', name), text);
}

const reply = (id: string | undefined, ts: string | undefined, model: string, usage: Record<string, number>) => ({
  sessionId: 's1',
  ...(ts ? { timestamp: ts } : {}),
  message: { ...(id ? { id } : {}), model, usage },
});

test('one API response is counted once, even when the log repeats it', async () => {
  writeTranscript('s1.jsonl', [
    reply('m1', '2026-10-01T10:00:00.000Z', 'claude-sonnet-5-5', { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 1000, cache_creation_input_tokens: 200 }),
    reply('m1', '2026-10-01T10:00:01.000Z', 'claude-sonnet-5-5', { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 1000, cache_creation_input_tokens: 200 }),
    reply('m2', '2026-10-01T11:00:00.000Z', 'claude-opus-5-5', { input_tokens: 200, output_tokens: 100 }),
    'this line is not json',
  ]);

  const { report, progress } = await scanClaudeUsage({});
  assert.equal(report.usage.messages.count, 2);
  assert.equal(progress.duplicatesSkipped, 1);
  assert.equal(report.usage.tokens.input, 300);
  assert.equal(report.usage.tokens.output, 150);
  assert.equal(report.usage.tokens.by_model['claude-sonnet-5-5'].cache_read, 1000);
  assert.equal(report.usage.tokens.by_model['claude-sonnet-5-5'].cache_write, 200);
});

test('lines without usage are ignored, and a reply without an id is still counted', async () => {
  writeTranscript('s1.jsonl', [
    { sessionId: 's1', timestamp: '2026-10-01T10:00:00.000Z', message: { model: 'claude-sonnet-5-5' } },
    reply(undefined, '2026-10-01T10:05:00.000Z', 'claude-sonnet-5-5', { input_tokens: 7, output_tokens: 3 }),
  ]);
  const { report } = await scanClaudeUsage({});
  assert.equal(report.usage.messages.count, 1);
  assert.equal(report.usage.tokens.input, 7);
});

test('days follow the local calendar, not UTC', async () => {
  const lateLocal = new Date(2026, 9, 1, 23, 30).toISOString(); // 23:30 local on Oct 1
  writeTranscript('s1.jsonl', [reply('m1', lateLocal, 'claude-sonnet-5-5', { input_tokens: 1, output_tokens: 1 })]);
  const { report } = await scanClaudeUsage({});
  assert.equal(report.usage.messages.by_day[0].date, localDayKey(new Date(2026, 9, 1, 23, 30)));
  assert.equal(report.usage.messages.by_day[0].date, '2026-10-01');
});

test('the end date includes the whole day, and entries without a timestamp are left out of a date range', async () => {
  writeTranscript('s1.jsonl', [
    reply('m1', new Date(2026, 9, 1, 23, 0).toISOString(), 'claude-sonnet-5-5', { input_tokens: 10, output_tokens: 0 }),
    reply('m2', new Date(2026, 9, 2, 1, 0).toISOString(), 'claude-sonnet-5-5', { input_tokens: 99, output_tokens: 0 }),
    reply('m3', undefined, 'claude-sonnet-5-5', { input_tokens: 1000, output_tokens: 0 }),
  ]);
  const { report } = await scanClaudeUsage({ startDate: '2026-10-01', endDate: '2026-10-01' });
  assert.equal(report.usage.messages.count, 1);
  assert.equal(report.usage.tokens.input, 10);
});

test('bad date text is rejected instead of rolling over', () => {
  assert.equal(parseLocalDate('2026-13-45'), null);
  assert.equal(parseLocalDate('2026-02-31'), null);
  assert.equal(parseLocalDate('next tuesday'), null);
  assert.notEqual(parseLocalDate('2026-09-30'), null);
});

test('saved history fills in days that the transcripts no longer have', async () => {
  writeTranscript('s1.jsonl', [reply('m1', '2026-10-05T10:00:00.000Z', 'claude-sonnet-5-5', { input_tokens: 5, output_tokens: 5 })]);
  const { report, dayDetail } = await scanClaudeUsage({});
  const stored = {
    '2026-09-01': { count: 4, input: 40, output: 8, by_model: { 'claude-opus-5-5': { input: 40, output: 8, cache_read: 0, cache_write: 0 } } },
    // Same day as the scan: the fresh scan should win
    '2026-10-05': { count: 99, input: 999, output: 999, by_model: {} },
  };
  const added = addHistoryToReport(report, dayDetail, stored);
  assert.equal(added, 1);
  assert.equal(report.usage.messages.count, 1 + 4);
  assert.equal(report.usage.tokens.input, 5 + 40);
  assert.equal(report.usage.messages.by_day[0].date, '2026-09-01');
  assert.equal(report.usage.tokens.by_model['claude-opus-5-5'].input, 40);
});
