import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { loadHistoryChecked, saveHistory, mergeForSave, addHistoryToReport, sameZone, currentTimeZone } from '../src/history.ts';
import { buildReport } from '../src/report.ts';

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

// ---- Never lose saved history ----

test('a history file that cannot be opened is left exactly as it is, and nothing is saved over it', () => {
  // A folder where the file should be: reading it fails with something other than "not found"
  fs.mkdirSync(file, { recursive: true });
  const loaded = loadHistoryChecked(file);
  assert.equal(loaded.safeToSave, false);
  assert.match(loaded.warning ?? '', /left as it is/);
  assert.equal(fs.statSync(file).isDirectory(), true, 'nothing was moved or removed');
});

test('days that look damaged are written back unchanged, so saving never deletes them', () => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({
    version: 1,
    days: {
      '2026-10-01': day(3, 30),
      '2026-10-02': { count: 5, input: null, output: 1, by_model: {} },   // a day this version cannot read
      '2026-10-03': day(2, 20),
    },
  }));
  const loaded = loadHistoryChecked(file);
  assert.deepEqual(Object.keys(loaded.days).sort(), ['2026-10-01', '2026-10-03']);
  assert.deepEqual(Object.keys(loaded.unreadable), ['2026-10-02']);
  assert.match(loaded.warning ?? '', /1 saved day could not be read and was skipped\. It stays in the file/);

  saveHistory(mergeForSave(loaded.days, { '2026-10-04': day(1, 10) }), file, { unreadable: loaded.unreadable });
  const after = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(Object.keys(after.days).sort(), ['2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04']);
  assert.equal(after.days['2026-10-02'].input, null, 'kept exactly as it was');
});

test('a new day that is read fine replaces its unreadable copy', () => {
  saveHistory({ '2026-10-02': day(2, 20) }, file, { unreadable: { '2026-10-02': { broken: true } } });
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).days['2026-10-02'].count, 2);
});

test('a scanned day whose numbers are not real is never saved over a good one', () => {
  const bad: any = { count: 5, input: Infinity, output: 1, by_model: {} };
  const merged = mergeForSave({ '2026-10-02': day(3, 30) }, { '2026-10-02': bad, '2026-10-03': bad });
  assert.equal(merged['2026-10-02'].count, 3);
  assert.equal(merged['2026-10-03'], undefined);
});

// ---- Days are kept per time zone ----

test('the time zone is saved with the days and read back', () => {
  saveHistory({ '2026-10-01': day(1, 1) }, file, { timeZone: 'America/New_York' });
  assert.equal(loadHistoryChecked(file).timeZone, 'America/New_York');
  saveHistory({ '2026-10-01': day(1, 1) }, file);
  assert.equal(loadHistoryChecked(file).timeZone, undefined, 'an older file has no zone');
});

test('days from the same zone, or from a file that names no zone, are used as before', () => {
  assert.equal(sameZone('Europe/Paris', 'Europe/Paris'), true);
  assert.equal(sameZone(undefined, 'Europe/Paris'), true);
  assert.equal(sameZone('Europe/Paris', undefined), true);
  assert.equal(sameZone('Europe/Paris', 'Asia/Tokyo'), false);
});

test('days saved in another time zone are used only where they do not touch what the scan found', () => {
  const report: any = {
    period: { start: '2026-10-05T00:00:00.000Z', end: '2026-10-09T23:00:00.000Z' },
    usage: { tokens: { input: 0, output: 0, cached: 0, by_model: {} }, messages: { count: 0, by_day: [], unfinished: 0 }, sessions: { count: 0 } },
  };
  const current = { '2026-10-05': day(4, 40), '2026-10-06': day(4, 40) };
  const stored = {
    '2026-09-20': day(7, 70),   // well before the scan: used
    '2026-10-03': day(7, 70),   // two days before: used
    '2026-10-04': day(9, 90),   // the day before the scan starts: could overlap, so not used
    '2026-10-05': day(9, 90),   // inside the scan, and "fuller": not used when the zone differs
    '2026-10-07': day(9, 90),   // the day after the scan ends: could overlap
    '2026-10-12': day(3, 30),   // clear of the scan: used
  };
  const added = addHistoryToReport(report, current, stored, { sameZone: false });
  assert.equal(added, 3);
  assert.deepEqual(report.usage.messages.by_day.map((d: any) => d.date), ['2026-09-20', '2026-10-03', '2026-10-12']);
  // The same days in the same zone work as always: the fuller copy of an overlapping day wins
  const again: any = JSON.parse(JSON.stringify({ ...report, usage: { ...report.usage, messages: { count: 0, by_day: [], unfinished: 0 }, tokens: { input: 0, output: 0, cached: 0, by_model: {} } } }));
  assert.equal(addHistoryToReport(again, current, stored, { sameZone: true }), 6 - 0, 'every saved day that is not smaller than the scan');
});

test('saving in another zone keeps only saved days clear of the scan, then the scan', () => {
  const stored = { '2026-09-20': day(7, 70), '2026-10-04': day(9, 90), '2026-10-05': day(9, 90), '2026-10-12': day(3, 30) };
  const current = { '2026-10-05': day(4, 40), '2026-10-06': day(4, 40) };
  const merged = mergeForSave(stored, current, { sameZone: false });
  assert.deepEqual(Object.keys(merged).sort(), ['2026-09-20', '2026-10-05', '2026-10-06', '2026-10-12']);
  assert.equal(merged['2026-10-05'].count, 4, 'the scan wins where it reaches');
  const sameClock = mergeForSave(stored, current, { sameZone: true });
  assert.equal(sameClock['2026-10-05'].count, 9, 'in the same zone the fuller copy still wins');
});

// ---- The case from the security review: scanning in one zone, then another ----

test('scanning in a different time zone than the one the history was saved in does not count replies twice', async () => {
  const claude = path.join(dir, 'claude');
  const projects = path.join(claude, 'proj');
  fs.mkdirSync(path.join(claude, 'projects', 'proj'), { recursive: true });
  // 26 days of replies around the clock, written as exact instants, so no zone is favoured
  const lines: string[] = [];
  let n = 0;
  const start = Date.parse('2026-09-01T00:00:00Z');
  for (let d = 0; d < 26; d++) {
    for (const hour of [0, 1, 5, 11, 16, 20, 23]) {
      lines.push(JSON.stringify({
        sessionId: 's', timestamp: new Date(start + d * 86_400_000 + hour * 3_600_000 + 1_800_000).toISOString(),
        message: { id: `m${n++}`, model: 'claude-sonnet-5-5', stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 5 } },
      }));
    }
  }
  fs.writeFileSync(path.join(claude, 'projects', 'proj', 's.jsonl'), lines.join('\n') + '\n');

  const saved = { claude: process.env.CLAUDE_CONFIG_DIR, home: process.env.LLM_USAGE_HOME, tz: process.env.TZ };
  process.env.CLAUDE_CONFIG_DIR = claude;
  process.env.LLM_USAGE_HOME = path.join(dir, 'home2');
  try {
    process.env.TZ = 'America/New_York';
    const first = await buildReport({ save: true });
    assert.equal(first.report.usage.messages.count, lines.length);
    for (const tz of ['Europe/London', 'Asia/Kolkata', 'Asia/Tokyo', 'Pacific/Auckland']) {
      process.env.TZ = tz;
      const again = await buildReport({ save: false });
      assert.equal(again.report.usage.messages.count, lines.length, `${tz}: ${again.report.usage.messages.count} replies, expected ${lines.length}`);
    }
    // and saving in the new zone keeps the count right on the next scan too
    process.env.TZ = 'Asia/Tokyo';
    await buildReport({ save: true });
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'home2', 'history.json'), 'utf8')).timeZone, currentTimeZone());
    process.env.TZ = 'Pacific/Auckland';
    assert.equal((await buildReport({ save: false })).report.usage.messages.count, lines.length);
  } finally {
    for (const [key, value] of [['CLAUDE_CONFIG_DIR', saved.claude], ['LLM_USAGE_HOME', saved.home], ['TZ', saved.tz]] as const) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
  void projects;
});

test('a scan does not overwrite a history it could not read', async () => {
  const claude = path.join(dir, 'claude2');
  fs.mkdirSync(path.join(claude, 'projects', 'p'), { recursive: true });
  fs.writeFileSync(path.join(claude, 'projects', 'p', 's.jsonl'), JSON.stringify({
    sessionId: 's', timestamp: new Date(Date.now() - 3 * 86_400_000).toISOString(),
    message: { id: 'a', model: 'claude-sonnet-5-5', stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } },
  }) + '\n');
  const home = path.join(dir, 'home3');
  // A folder where history.json should be
  fs.mkdirSync(path.join(home, 'history.json'), { recursive: true });
  const saved = { claude: process.env.CLAUDE_CONFIG_DIR, home: process.env.LLM_USAGE_HOME };
  process.env.CLAUDE_CONFIG_DIR = claude;
  process.env.LLM_USAGE_HOME = home;
  try {
    const built = await buildReport({ save: true });
    assert.match(built.historyWarning ?? '', /left as it is/);
    assert.match(built.historySaveError ?? '', /left as it is/);
    assert.equal(fs.statSync(path.join(home, 'history.json')).isDirectory(), true);
  } finally {
    for (const [key, value] of [['CLAUDE_CONFIG_DIR', saved.claude], ['LLM_USAGE_HOME', saved.home]] as const) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});
