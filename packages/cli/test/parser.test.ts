import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { scanClaudeUsage, localDayKey, parseLocalDate } from '../src/parsers/claude.ts';
import { addHistoryToReport, mergeForSave } from '../src/history.ts';

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

test('cache writes are split by lifetime when the log has the breakdown', async () => {
  writeTranscript('s1.jsonl', [
    reply('m1', '2026-10-01T10:00:00.000Z', 'claude-sonnet-5-5', {
      input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 500, cache_read_input_tokens: 0,
    }),
    {
      sessionId: 's1', timestamp: '2026-10-01T10:01:00.000Z',
      message: { id: 'm2', model: 'claude-sonnet-5-5', usage: {
        input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 500,
        cache_creation: { ephemeral_5m_input_tokens: 200, ephemeral_1h_input_tokens: 300 },
      } },
    },
  ]);
  const { report } = await scanClaudeUsage({});
  const m = report.usage.tokens.by_model['claude-sonnet-5-5'];
  // m1 has no split, so its 500 are 5-minute. m2 is 200 five-minute plus 300 one-hour.
  assert.equal(m.cache_write, 700);
  assert.equal(m.cache_write_1h, 300);
  assert.equal(report.usage.tokens.cached, 1000);
});

test('saving keeps the fuller copy of a day, so a partial day never overwrites a complete one', () => {
  const full = { count: 10, input: 100, output: 10, by_model: {} };
  const partial = { count: 3, input: 30, output: 3, by_model: {} };
  const merged = mergeForSave({ '2026-10-02': full }, { '2026-10-02': partial, '2026-10-03': partial });
  assert.equal(merged['2026-10-02'].count, 10);
  assert.equal(merged['2026-10-03'].count, 3);
  const upgraded = mergeForSave({ '2026-10-02': partial }, { '2026-10-02': full });
  assert.equal(upgraded['2026-10-02'].count, 10);
});

test('a Haiku 5.5 request with a prompt over 100K tokens is filed under the long-prompt rate', async () => {
  writeTranscript('s1.jsonl', [
    reply('h1', '2026-10-01T10:00:00.000Z', 'claude-haiku-5-5', { input_tokens: 150_000, output_tokens: 10 }),
    reply('h2', '2026-10-01T10:01:00.000Z', 'claude-haiku-5-5', { input_tokens: 60_000, cache_read_input_tokens: 50_000, output_tokens: 10 }),
    reply('h3', '2026-10-01T10:02:00.000Z', 'claude-haiku-5-5', { input_tokens: 5_000, output_tokens: 10 }),
  ]);
  const { report } = await scanClaudeUsage({});
  // h1 (150K) and h2 (110K with cache) are long. h3 is short.
  assert.equal(report.usage.tokens.by_model['claude-haiku-5-5-long-prompt'].input, 210_000);
  assert.equal(report.usage.tokens.by_model['claude-haiku-5-5'].input, 5_000);
});

test('when a reply is logged more than once, the largest output count is kept', async () => {
  writeTranscript('s1.jsonl', [
    reply('m9', '2026-10-01T10:00:00.000Z', 'claude-opus-5-5', { input_tokens: 10, output_tokens: 5 }),
    reply('m9', '2026-10-01T10:00:05.000Z', 'claude-opus-5-5', { input_tokens: 10, output_tokens: 50 }),
  ]);
  const { report, progress } = await scanClaudeUsage({});
  assert.equal(report.usage.messages.count, 1);
  assert.equal(progress.duplicatesSkipped, 1);
  assert.equal(report.usage.tokens.output, 50);
});
