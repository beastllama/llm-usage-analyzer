import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { loadHistoryChecked, saveHistory, mergeForSave, addHistoryToReport } from '../src/history.ts';

let dir: string;
let file: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-usage-history-'));
  file = path.join(dir, 'home', 'history.json');
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const model = (input: number) => ({ input, output: 1, cache_read: 0, cache_write: 0, cache_write_1h: 0 });
const day = (count: number, input: number, extra: Record<string, unknown> = {}) =>
  ({ count, input, output: 1, by_model: { 'claude-sonnet-5-5': model(input) }, ...extra });

test('saved days survive a save and a load, and the file is private', () => {
  saveHistory({ '2026-10-01': day(3, 30, { unfinished: 2 }) }, file);
  const { days, warning } = loadHistoryChecked(file);
  assert.equal(warning, undefined);
  assert.equal(days['2026-10-01'].count, 3);
  assert.equal(days['2026-10-01'].unfinished, 2);
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o700);
  }
});

test('a missing history file is simply empty, with no warning', () => {
  const loaded = loadHistoryChecked(file);
  assert.deepEqual(Object.keys(loaded.days), []);
  assert.equal(loaded.warning, undefined);
});

test('a damaged history file is moved aside, never overwritten or deleted', () => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{"version":1,"days":{"2026-10-01":{"count":40');   // cut off in the middle
  const { days, warning } = loadHistoryChecked(file);
  assert.deepEqual(Object.keys(days), []);
  assert.match(warning ?? '', /could not be read/);
  const kept = fs.readdirSync(path.dirname(file)).filter(f => f.includes('unreadable'));
  assert.equal(kept.length, 1);
  assert.match(fs.readFileSync(path.join(path.dirname(file), kept[0]), 'utf8'), /"count":40/);
  assert.equal(fs.existsSync(file), false, 'a new file will be started on the next save');
});

test('valid JSON of another shape or version is treated as damaged, and does not crash', () => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  for (const text of ['[]', '{"days":[]}', '{"version":2,"days":{}}', '"text"', 'null']) {
    fs.writeFileSync(file, text);
    assert.doesNotThrow(() => loadHistoryChecked(file));
    assert.deepEqual(Object.keys(loadHistoryChecked(file).days), []);
  }
});

test('days that are not real numbers are skipped one by one, and the good days stay', () => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({
    version: 1,
    days: {
      '2026-10-01': day(3, 30),
      '2026-10-02': day(-1, 30),
      '2026-10-03': { count: '5', input: 1, output: 1, by_model: {} },
      '2026-10-04': { count: 1, input: 1, output: 1, by_model: { x: 'nope' } },
      'not-a-date': day(1, 1),
      '2026-10-05': null,
    },
  }));
  const { days, warning } = loadHistoryChecked(file);
  assert.deepEqual(Object.keys(days), ['2026-10-01']);
  assert.match(warning ?? '', /5 saved days could not be read/);
});

test('a model called __proto__ in the history file is a normal entry and pollutes nothing', () => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{"version":1,"days":{"2026-10-01":{"count":1,"input":5,"output":1,"by_model":{"__proto__":{"input":5,"output":1,"cache_read":0,"cache_write":0,"cache_write_1h":0}}}}}');
  const { days } = loadHistoryChecked(file);
  assert.deepEqual(Object.keys(days['2026-10-01'].by_model), ['__proto__']);
  assert.equal(({} as any).input, undefined);
});

test('saving does not write through a file or link planted at a guessable temp name', () => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const victim = path.join(dir, 'victim.txt');
  fs.writeFileSync(victim, 'keep me');
  try { fs.symlinkSync(victim, `${file}.${process.pid}.tmp`); } catch { return; }
  saveHistory({ '2026-10-01': day(1, 1) }, file);
  assert.equal(fs.readFileSync(victim, 'utf8'), 'keep me');
  assert.equal(loadHistoryChecked(file).days['2026-10-01'].count, 1);
});

test('merging for save keeps the fuller day and the unfinished count that goes with it', () => {
  const full = day(10, 100, { unfinished: 4 });
  const partial = day(3, 30, { unfinished: 1 });
  const merged = mergeForSave({ '2026-10-02': full }, { '2026-10-02': partial, '2026-10-03': partial });
  assert.equal(merged['2026-10-02'].count, 10);
  assert.equal(merged['2026-10-02'].unfinished, 4);
  assert.equal(merged['2026-10-03'].count, 3);
});

test('a restored day brings its unfinished replies back into the report', () => {
  const report: any = {
    period: { start: '2026-10-05T00:00:00.000Z', end: '2026-10-05T23:00:00.000Z' },
    usage: { tokens: { input: 0, output: 0, cached: 0, by_model: {} }, messages: { count: 0, by_day: [], unfinished: 0 }, sessions: { count: 0 } },
  };
  assert.equal(addHistoryToReport(report, {}, { '2026-09-01': day(4, 40, { unfinished: 3 }) }), 1);
  assert.equal(report.usage.messages.count, 4);
  assert.equal(report.usage.messages.unfinished, 3);
  assert.equal(report.usage.tokens.input, 40);
});
