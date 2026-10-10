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

/** An instant on this computer's clock. The scanner puts each reply on a day by local time, so the tests build their times the same way. */
const local = (month: number, day: number, hour = 10, minute = 0, second = 0) =>
  new Date(2026, month - 1, day, hour, minute, second).toISOString();

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
    reply('m1', local(10, 1, 10, 0, 0), 'claude-sonnet-5-5', { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 1000, cache_creation_input_tokens: 200 }),
    reply('m1', local(10, 1, 10, 0, 1), 'claude-sonnet-5-5', { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 1000, cache_creation_input_tokens: 200 }),
    reply('m2', local(10, 1, 11, 0, 0), 'claude-opus-5-5', { input_tokens: 200, output_tokens: 100 }),
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
    { sessionId: 's1', timestamp: local(10, 1, 10, 0, 0), message: { model: 'claude-sonnet-5-5' } },
    reply(undefined, local(10, 1, 10, 5, 0), 'claude-sonnet-5-5', { input_tokens: 7, output_tokens: 3 }),
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

test('saved history fills in days that the transcripts no longer have, and wins when it has more replies', async () => {
  writeTranscript('s1.jsonl', [reply('m1', local(10, 5, 10, 0, 0), 'claude-sonnet-5-5', { input_tokens: 5, output_tokens: 5 })]);
  const { report, dayDetail } = await scanClaudeUsage({});
  const day = (count: number, input: number) => ({ count, input, output: 8, by_model: { 'claude-opus-5-5': { input, output: 8, cache_read: 0, cache_write: 0, cache_write_1h: 0 } } });
  const stored = {
    '2026-09-01': day(4, 40),
    // Same day as the scan, but the saved copy has more replies, so part of that day's transcripts is gone
    '2026-10-05': day(99, 999),
  };
  const added = addHistoryToReport(report, dayDetail, stored);
  assert.equal(added, 2);
  assert.equal(report.usage.messages.count, 4 + 99);
  assert.equal(report.usage.tokens.input, 40 + 999);
  assert.equal(report.usage.messages.by_day[0].date, '2026-09-01');
  assert.equal(report.usage.messages.by_day.find(d => d.date === '2026-10-05')?.count, 99);
  assert.equal(report.usage.tokens.by_model['claude-opus-5-5'].input, 1039);
  assert.equal(report.usage.tokens.by_model['claude-sonnet-5-5'], undefined, 'the replaced scan day leaves no empty model behind');
});

test('a scanned day with more replies than the saved copy wins', async () => {
  writeTranscript('s1.jsonl', [
    reply('m1', local(10, 5, 10, 0, 0), 'claude-sonnet-5-5', { input_tokens: 5, output_tokens: 5 }),
    reply('m2', local(10, 5, 11, 0, 0), 'claude-sonnet-5-5', { input_tokens: 6, output_tokens: 5 }),
  ]);
  const { report, dayDetail } = await scanClaudeUsage({});
  const stored = { '2026-10-05': { count: 1, input: 1, output: 1, by_model: {} } };
  assert.equal(addHistoryToReport(report, dayDetail, stored), 0);
  assert.equal(report.usage.messages.count, 2);
  assert.equal(report.usage.tokens.input, 11);
});

test('cache writes are split by lifetime when the log has the breakdown', async () => {
  writeTranscript('s1.jsonl', [
    reply('m1', local(10, 1, 10, 0, 0), 'claude-sonnet-5-5', {
      input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 500, cache_read_input_tokens: 0,
    }),
    {
      sessionId: 's1', timestamp: local(10, 1, 10, 1, 0),
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
    reply('h1', local(10, 1, 10, 0, 0), 'claude-haiku-5-5', { input_tokens: 150_000, output_tokens: 10 }),
    reply('h2', local(10, 1, 10, 1, 0), 'claude-haiku-5-5', { input_tokens: 60_000, cache_read_input_tokens: 50_000, output_tokens: 10 }),
    reply('h3', local(10, 1, 10, 2, 0), 'claude-haiku-5-5', { input_tokens: 5_000, output_tokens: 10 }),
  ]);
  const { report } = await scanClaudeUsage({});
  // h1 (150K) and h2 (110K with cache) are long. h3 is short.
  assert.equal(report.usage.tokens.by_model['claude-haiku-5-5-long-prompt'].input, 210_000);
  assert.equal(report.usage.tokens.by_model['claude-haiku-5-5'].input, 5_000);
});

test('when a reply is logged more than once, the largest output count is kept', async () => {
  writeTranscript('s1.jsonl', [
    reply('m9', local(10, 1, 10, 0, 0), 'claude-opus-5-5', { input_tokens: 10, output_tokens: 5 }),
    reply('m9', local(10, 1, 10, 0, 5), 'claude-opus-5-5', { input_tokens: 10, output_tokens: 50 }),
  ]);
  const { report, progress } = await scanClaudeUsage({});
  assert.equal(report.usage.messages.count, 1);
  assert.equal(progress.duplicatesSkipped, 1);
  assert.equal(report.usage.tokens.output, 50);
});

// ---- Reading the log carefully ----

/** A line as Claude Code writes it, with the fields the scanner looks at. */
const line = (
  id: string | undefined,
  ts: string,
  model: string,
  usage: Record<string, unknown>,
  extra: { stop?: string | null; entry?: Record<string, unknown> } = {},
) => ({
  sessionId: 's1',
  timestamp: ts,
  ...(extra.entry ?? {}),
  message: { ...(id ? { id } : {}), model, ...(extra.stop !== undefined ? { stop_reason: extra.stop } : {}), usage },
});

test('placeholder rows for interrupted turns and API errors are not replies', async () => {
  writeTranscript('s1.jsonl', [
    line('m1', local(10, 1, 10, 0, 0), '<synthetic>', { input_tokens: 0, output_tokens: 0 }),
    line('m2', local(10, 1, 10, 1, 0), 'claude-sonnet-5-5', { input_tokens: 0, output_tokens: 0 }, { entry: { isApiErrorMessage: true } }),
    line('m3', local(10, 1, 10, 2, 0), 'claude-sonnet-5-5', { input_tokens: 10, output_tokens: 5 }, { stop: 'end_turn' }),
  ]);
  const { report } = await scanClaudeUsage({});
  assert.equal(report.usage.messages.count, 1);
  assert.deepEqual(Object.keys(report.usage.tokens.by_model), ['claude-sonnet-5-5']);
});

test('a reply whose lines never say how it ended is unfinished, and a later line that does fixes that', async () => {
  writeTranscript('s1.jsonl', [
    // Only the first line of the stream was logged: a tiny output count and no stop reason
    line('start-only', local(10, 1, 10, 0, 0), 'claude-sonnet-5-5', { input_tokens: 5, output_tokens: 7 }, { stop: null }),
    // Streamed, then finished
    line('done', local(10, 1, 10, 1, 0), 'claude-sonnet-5-5', { input_tokens: 5, output_tokens: 7 }, { stop: null }),
    line('done', local(10, 1, 10, 1, 2), 'claude-sonnet-5-5', { input_tokens: 5, output_tokens: 400 }, { stop: 'end_turn' }),
    // An old log with no stop_reason field at all
    line('no-field', local(10, 2, 10, 0, 0), 'claude-sonnet-5-5', { input_tokens: 5, output_tokens: 50 }),
  ]);
  const { report, dayDetail } = await scanClaudeUsage({});
  assert.equal(report.usage.messages.count, 3);
  assert.equal(report.usage.messages.unfinished, 2);
  assert.equal(dayDetail['2026-10-01'].unfinished, 1);
  assert.equal(dayDetail['2026-10-02'].unfinished, 1);
  assert.equal(report.usage.tokens.output, 7 + 400 + 50);
});

test('cache writes: the flat total is the whole, and a split that covers only part cannot lose tokens', async () => {
  writeTranscript('s1.jsonl', [
    line('flat-only', local(10, 1, 10, 0, 0), 'claude-sonnet-5-5', { cache_creation_input_tokens: 1000 }, { stop: 'end_turn' }),
    line('full-split', local(10, 1, 10, 1, 0), 'claude-sonnet-5-5', {
      cache_creation_input_tokens: 1000, cache_creation: { ephemeral_5m_input_tokens: 400, ephemeral_1h_input_tokens: 600 },
    }, { stop: 'end_turn' }),
    // The split covers 100 + 200 of 1000: the other 700 are treated as 5-minute writes
    line('part-split', local(10, 1, 10, 2, 0), 'claude-sonnet-5-5', {
      cache_creation_input_tokens: 1000, cache_creation: { ephemeral_5m_input_tokens: 100, ephemeral_1h_input_tokens: 200 },
    }, { stop: 'end_turn' }),
    // No flat total: the split is all there is
    line('split-only', local(10, 1, 10, 3, 0), 'claude-sonnet-5-5', {
      cache_creation: { ephemeral_5m_input_tokens: 10, ephemeral_1h_input_tokens: 20 },
    }, { stop: 'end_turn' }),
  ]);
  const { report } = await scanClaudeUsage({});
  const m = report.usage.tokens.by_model['claude-sonnet-5-5'];
  assert.equal(m.cache_write_1h, 0 + 600 + 200 + 20);
  assert.equal(m.cache_write, 1000 + 400 + 800 + 10);
  assert.equal(report.usage.tokens.cached, 1000 + 1000 + 1000 + 30);
});

test('token counts that are not numbers of 0 or more count as 0', async () => {
  writeTranscript('s1.jsonl', [
    line('m1', local(10, 1, 10, 0, 0), 'claude-sonnet-5-5', {
      input_tokens: '100', output_tokens: -5, cache_read_input_tokens: true, cache_creation_input_tokens: null,
    }),
    line('m2', local(10, 1, 10, 1, 0), 'claude-sonnet-5-5', { input_tokens: 12.9, output_tokens: 1e999 }),
  ]);
  const { report } = await scanClaudeUsage({});
  const m = report.usage.tokens.by_model['claude-sonnet-5-5'];
  assert.equal(report.usage.messages.count, 2);
  assert.equal(m.input, 12);
  assert.equal(m.output, 0);
  assert.equal(m.cache_read, 0);
  assert.equal(m.cache_write, 0);
});

test('timestamps before 2024 or more than a day ahead are ignored, so they cannot stretch the period', async () => {
  const future = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString();
  writeTranscript('s1.jsonl', [
    line('old', '1970-01-01T00:00:00.000Z', 'claude-sonnet-5-5', { input_tokens: 1, output_tokens: 1 }),
    line('future', future, 'claude-sonnet-5-5', { input_tokens: 2, output_tokens: 1 }),
    line('ok', local(10, 1, 10, 0, 0), 'claude-sonnet-5-5', { input_tokens: 4, output_tokens: 1 }),
  ]);
  const { report } = await scanClaudeUsage({});
  assert.equal(report.usage.messages.count, 3, 'they still count in the totals');
  assert.equal(report.usage.tokens.input, 7);
  assert.deepEqual(report.usage.messages.by_day.map(d => d.date), ['2026-10-01'], 'but they are not placed on a day');
  assert.equal(report.period.start.slice(0, 10) === report.period.end.slice(0, 10), true);
});

test('a model called __proto__ is a normal entry and pollutes nothing', async () => {
  writeTranscript('s1.jsonl', [
    line('m1', local(10, 1, 10, 0, 0), '__proto__', { input_tokens: 5, output_tokens: 5 }),
    line('m2', local(10, 1, 10, 1, 0), 'constructor', { input_tokens: 6, output_tokens: 5 }),
  ]);
  const { report } = await scanClaudeUsage({});
  assert.equal(Object.keys(report.usage.tokens.by_model).sort().join(','), '__proto__,constructor');
  assert.equal(({} as any).input, undefined);
  assert.equal(JSON.parse(JSON.stringify(report)).usage.tokens.by_model['__proto__'].input, 5);
});

test('a reply copied into a second file (a resumed session) is counted once', async () => {
  const same = line('shared', local(10, 1, 10, 0, 0), 'claude-sonnet-5-5', { input_tokens: 100, output_tokens: 10 }, { stop: 'end_turn' });
  writeTranscript('first.jsonl', [same]);
  writeTranscript('resumed.jsonl', [same, line('new', local(10, 1, 11, 0, 0), 'claude-sonnet-5-5', { input_tokens: 1, output_tokens: 1 }, { stop: 'end_turn' })]);
  const { report, progress } = await scanClaudeUsage({});
  assert.equal(report.usage.messages.count, 2);
  assert.equal(report.usage.tokens.input, 101);
  assert.equal(progress.duplicatesSkipped, 1);
});

test('when a reply repeats, the largest count of each kind is kept', async () => {
  writeTranscript('s1.jsonl', [
    line('m1', local(10, 1, 10, 0, 0), 'claude-sonnet-5-5', { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100 }),
    line('m1', local(10, 1, 10, 0, 1), 'claude-sonnet-5-5', { input_tokens: 30, output_tokens: 90, cache_read_input_tokens: 300 }),
    line('m1', local(10, 1, 10, 0, 2), 'claude-sonnet-5-5', { input_tokens: 20, output_tokens: 40, cache_read_input_tokens: 200 }),
  ]);
  const { report } = await scanClaudeUsage({});
  const m = report.usage.tokens.by_model['claude-sonnet-5-5'];
  assert.deepEqual([m.input, m.output, m.cache_read], [30, 90, 300]);
});

test('a byte-order mark and Windows line endings do not hide a reply', async () => {
  const a = JSON.stringify(line('m1', local(10, 1, 10, 0, 0), 'claude-sonnet-5-5', { input_tokens: 3, output_tokens: 1 }));
  const b = JSON.stringify(line('m2', local(10, 1, 10, 1, 0), 'claude-sonnet-5-5', { input_tokens: 4, output_tokens: 1 }));
  fs.writeFileSync(path.join(dir, 'projects', 'proj-a', 's1.jsonl'), '﻿' + a + '\r\n' + b + '\r\n');
  const { report } = await scanClaudeUsage({});
  assert.equal(report.usage.messages.count, 2);
  assert.equal(report.usage.tokens.input, 7);
});

test('a big transcript is read in chunks and gives the same answer, even when a line crosses a chunk edge', async () => {
  const CHUNK = 1024 * 1024;
  const out: string[] = [];
  let bytes = 0;
  const push = (text: string) => { out.push(text); bytes += Buffer.byteLength(text) + 1; };
  const pad = (n: number) => JSON.stringify({ type: 'user', text: 'x'.repeat(Math.max(1, n)) });
  const reply = (n: number) => JSON.stringify(line(`big-${n}`, local(10, 1, 10, 0, 0), 'claude-sonnet-5-5', { input_tokens: n, output_tokens: 1 }, { stop: 'end_turn' }));

  push(reply(1));
  // Fill up to 100 bytes before each chunk edge, then put a reply (about 250 bytes) across it
  for (const [n, edge] of [[2, CHUNK], [3, 2 * CHUNK], [4, 8 * CHUNK + 4096]] as const) {
    while (edge - 100 - bytes > 64) push(pad(Math.min(edge - 100 - bytes - 64, 200_000)));
    push(reply(n));
  }
  push('{"broken": ');                 // a damaged line
  push(reply(5));
  fs.writeFileSync(path.join(dir, 'projects', 'proj-a', 'big.jsonl'), out.join('\n') + '\n');
  assert.ok(fs.statSync(path.join(dir, 'projects', 'proj-a', 'big.jsonl')).size > 8 * CHUNK, 'the file is over the whole-file limit');

  const { report } = await scanClaudeUsage({});
  assert.equal(report.usage.messages.count, 5);
  assert.equal(report.usage.tokens.input, 1 + 2 + 3 + 4 + 5);
});

test('a line over 32 MB is skipped with a note, and the rest of the file still counts', async () => {
  const huge = '{"message":{"usage":' + 'x'.repeat(33 * 1024 * 1024) + '}}';
  const ok = (n: number) => JSON.stringify(line(`ok-${n}`, local(10, 1, 10, 0, 0), 'claude-sonnet-5-5', { input_tokens: n, output_tokens: 1 }));
  fs.writeFileSync(path.join(dir, 'projects', 'proj-a', 'huge.jsonl'), [ok(1), huge, ok(2)].join('\n') + '\n');
  const { report, progress } = await scanClaudeUsage({});
  assert.equal(report.usage.messages.count, 2);
  assert.equal(report.usage.tokens.input, 3);
  assert.ok(progress.errors.some(e => e.includes('longer than 32 MB')));
});

test('a file that cannot be read is reported and the others still count', async () => {
  writeTranscript('good.jsonl', [line('m1', local(10, 1, 10, 0, 0), 'claude-sonnet-5-5', { input_tokens: 5, output_tokens: 1 })]);
  // A folder named like a transcript cannot be read as a file
  fs.mkdirSync(path.join(dir, 'projects', 'proj-a', 'bad.jsonl.d'));
  const { report } = await scanClaudeUsage({});
  assert.equal(report.usage.messages.count, 1);
});

// ---- Dates: edges ----

test('a date range includes its first moment and its last, and leaves out the moment after', async () => {
  const at = (d: number, h: number, m: number, sec = 0) => new Date(2026, 9, d, h, m, sec).toISOString();
  writeTranscript('s1.jsonl', [
    reply('before', at(1, 23, 59, 59), 'claude-sonnet-5-5', { input_tokens: 1, output_tokens: 0 }),
    reply('first', at(2, 0, 0, 0), 'claude-sonnet-5-5', { input_tokens: 10, output_tokens: 0 }),
    reply('last', at(3, 23, 59, 59), 'claude-sonnet-5-5', { input_tokens: 100, output_tokens: 0 }),
    reply('after', at(4, 0, 0, 0), 'claude-sonnet-5-5', { input_tokens: 1000, output_tokens: 0 }),
  ]);
  const { report } = await scanClaudeUsage({ startDate: '2026-10-02', endDate: '2026-10-03' });
  assert.equal(report.usage.tokens.input, 110, 'only "first" and "last"');
  assert.deepEqual(report.usage.messages.by_day.map((d) => d.date), ['2026-10-02', '2026-10-03']);
});

test('--days counts back from now', async () => {
  const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();
  writeTranscript('s1.jsonl', [
    reply('old', daysAgo(10), 'claude-sonnet-5-5', { input_tokens: 1000, output_tokens: 0 }),
    reply('recent', daysAgo(2), 'claude-sonnet-5-5', { input_tokens: 10, output_tokens: 0 }),
  ]);
  const { report } = await scanClaudeUsage({ days: 7 });
  assert.equal(report.usage.tokens.input, 10);
});

test('the day a reply belongs to follows the time zone of the computer it runs on', async () => {
  const before = process.env.TZ;
  try {
    // 03:30 UTC on Oct 2 is the evening of Oct 1 in Los Angeles, and the afternoon of Oct 2 in Auckland
    const instant = new Date('2026-10-02T03:30:00.000Z');
    process.env.TZ = 'America/Los_Angeles';
    assert.equal(localDayKey(instant), '2026-10-01');
    process.env.TZ = 'Pacific/Auckland';
    assert.equal(localDayKey(instant), '2026-10-02');
    process.env.TZ = 'Pacific/Kiritimati';
    assert.equal(localDayKey(new Date('2026-10-01T10:30:00.000Z')), '2026-10-02');
  } finally {
    if (before === undefined) delete process.env.TZ; else process.env.TZ = before;
  }
});

test('the Haiku 5.5 long-prompt line is exact: 100,000 prompt tokens is still the normal rate, 100,001 is not', async () => {
  const haiku = (id: string, usage: Record<string, number>) => reply(id, local(10, 1, 10, 0, 0), 'claude-haiku-5-5', { output_tokens: 1, ...usage });
  writeTranscript('s1.jsonl', [
    haiku('a', { input_tokens: 99_999 }),
    haiku('b', { input_tokens: 100_000 }),
    haiku('c', { input_tokens: 100_001 }),
    // cache reads and both kinds of cache writes count towards the prompt
    haiku('d', { input_tokens: 40_000, cache_read_input_tokens: 30_000, cache_creation_input_tokens: 30_001 }),
    haiku('e', { input_tokens: 1, cache_read_input_tokens: 99_999 }),
  ]);
  const { report } = await scanClaudeUsage({});
  const normal = report.usage.tokens.by_model['claude-haiku-5-5'];
  const long = report.usage.tokens.by_model['claude-haiku-5-5-long-prompt'];
  assert.equal(normal.input, 99_999 + 100_000 + 1, 'a, b and e stay at the normal rate');
  assert.equal(long.input, 100_001 + 40_000, 'c and d are over 100,000');
});

// ---- Strange logs (from the security review) ----

test('a count above any real request is treated as damaged, so a total can never become Infinity', async () => {
  writeTranscript('s1.jsonl', [
    reply('big1', local(10, 1, 10, 0), 'claude-sonnet-5-5', { input_tokens: 1e308, output_tokens: 5 }),
    reply('big2', local(10, 1, 10, 1), 'claude-sonnet-5-5', { input_tokens: 1e308, output_tokens: 5 }),
    reply('big3', local(10, 1, 10, 2), 'claude-sonnet-5-5', { input_tokens: 1e300, output_tokens: 5, cache_read_input_tokens: 5e9 }),
    reply('ok', local(10, 1, 10, 3), 'claude-sonnet-5-5', { input_tokens: 1_000_000_000, output_tokens: 7 }),
  ]);
  const { report } = await scanClaudeUsage({});
  assert.ok(Number.isFinite(report.usage.tokens.input));
  assert.equal(report.usage.tokens.input, 1_000_000_000, 'only the believable count is kept, and a billion is still believable');
  assert.equal(report.usage.tokens.output, 5 + 5 + 5 + 7);
  assert.equal(JSON.parse(JSON.stringify(report)).usage.tokens.input, 1_000_000_000, 'and it survives being written as JSON');
});

test('a model name that is far too long is cut, and the saved day does not carry it', async () => {
  writeTranscript('s1.jsonl', [reply('long', local(10, 1), 'claude-' + 'x'.repeat(2_000_000), { input_tokens: 5, output_tokens: 5 })]);
  const { report, dayDetail } = await scanClaudeUsage({});
  const names = Object.keys(report.usage.tokens.by_model);
  assert.equal(names.length, 1);
  assert.ok(names[0].length <= 100);
  assert.ok(Object.keys(Object.values(dayDetail)[0].by_model)[0].length <= 100);
});

test('only a model the price table knows as Haiku 5.5 is moved to the long-prompt rate', async () => {
  const haiku = (id: string, model: string, input: number) => reply(id, local(10, 1), model, { input_tokens: input, output_tokens: 1 });
  writeTranscript('s1.jsonl', [
    haiku('a', 'claude-haiku-5-5', 200_000),
    haiku('b', 'claude-haiku-5-5-20260315', 200_000),
    haiku('c', 'claude-haiku-5-5-foo', 200_000),       // a name that only starts the same: no price, no guess
    haiku('d', 'claude-haiku-5-55', 200_000),
    haiku('e', 'claude-haiku-5-5-foo', 1_000),
  ]);
  const { report } = await scanClaudeUsage({});
  const by = report.usage.tokens.by_model;
  assert.equal(by['claude-haiku-5-5-long-prompt'].input, 400_000, 'the two real Haiku 5.5 ids');
  assert.equal(by['claude-haiku-5-5-foo'].input, 201_000, 'the unknown name stays as it is, whatever the prompt size');
  assert.equal(by['claude-haiku-5-55'].input, 200_000);
});

test('file and folder names are cleaned before they are kept as messages', async () => {
  const dirName = 'bad\u001b]0;PWNED\u0007name';
  fs.mkdirSync(path.join(dir, 'projects', dirName), { recursive: true });
  // A "transcript" that is a folder cannot be read as a file, which produces an error message with its name in it
  fs.mkdirSync(path.join(dir, 'projects', dirName, 'x.jsonl'));
  fs.writeFileSync(path.join(dir, 'projects', dirName, 'good.jsonl'), '');
  const { progress } = await scanClaudeUsage({});
  for (const message of progress.errors) assert.ok(!/[\u0000-\u001f\u007f-\u009f]/.test(message), JSON.stringify(message));
});

test('a link inside the projects folder is not followed, and the scan says it skipped one', async () => {
  const outside = path.join(dir, 'outside');
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'secret.jsonl'), JSON.stringify({ message: { id: 'z', model: 'claude-sonnet-5-5', usage: { input_tokens: 99, output_tokens: 1 } } }) + '\n');
  try { fs.symlinkSync(outside, path.join(dir, 'projects', 'link-to-outside')); } catch { return; }
  const { report, progress } = await scanClaudeUsage({});
  assert.equal(report.usage.messages.count, 0, 'what is behind the link is not counted');
  assert.ok(progress.errors.some((e) => /Skipped a link, not counted/.test(e)));
});
