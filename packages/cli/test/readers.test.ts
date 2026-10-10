// The Codex CLI and Gemini CLI readers, on sample files in the exact shapes the tools write (test/fixtures).
// The shapes and the expected numbers come from each tool's own source code (Codex rust-v0.162.1, Gemini CLI v0.63).
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as zlib from 'zlib';
import { scanCodexUsage } from '../src/parsers/codex.ts';
import { scanGeminiUsage } from '../src/parsers/gemini.ts';

const FIXTURES = path.join(path.dirname(new URL(import.meta.url).pathname), 'fixtures');
const fixture = (name: string) => fs.readFileSync(path.join(FIXTURES, name), 'utf8');
const lines = (text: string) => text.split('\n').filter(Boolean);

let dir: string;
const saved = { codex: process.env.CODEX_HOME, gemini: process.env.GEMINI_CLI_HOME };

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-readers-'));
  process.env.CODEX_HOME = path.join(dir, 'codex');
  process.env.GEMINI_CLI_HOME = path.join(dir, 'gemini-home');
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  if (saved.codex === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = saved.codex;
  if (saved.gemini === undefined) delete process.env.GEMINI_CLI_HOME; else process.env.GEMINI_CLI_HOME = saved.gemini;
});

/** Write a Codex rollout into sessions/2026/10/09 (or another folder under CODEX_HOME). */
function rollout(name: string, text: string, sub = path.join('sessions', '2026', '10', '09')): string {
  const folder = path.join(dir, 'codex', sub);
  fs.mkdirSync(folder, { recursive: true });
  const file = path.join(folder, name);
  fs.writeFileSync(file, text);
  return file;
}

/** Write a Gemini chat file into a project's chats folder. */
function chat(name: string, text: string, project = 'acme-api'): void {
  const folder = path.join(dir, 'gemini-home', '.gemini', 'tmp', project, 'chats');
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, name), text);
}

// ---- Codex CLI

test('codex: each response is counted once from its usage record, with the model of its turn', async () => {
  rollout('rollout-2026-10-09T16-02-11-a.jsonl', fixture('codex-session.jsonl'));
  const { report } = await scanCodexUsage();
  assert.equal(report.product, 'chatgpt');
  assert.equal(report.tool, 'Codex CLI');
  assert.equal(report.usage.messages.count, 3, 'three responses; the rate-limit-only and repeated token_count lines are not usage');
  const terra = report.usage.tokens.by_model['gpt-5.6-terra'];
  const luna = report.usage.tokens.by_model['gpt-5.6-luna'];
  // input_tokens includes the cached tokens, so the new input is input minus cached
  assert.deepEqual(terra, { input: (18742 - 4864) + (21305 - 18560), output: 412 + 893, cache_read: 4864 + 18560, cache_write: 0, cache_write_1h: 0 });
  assert.deepEqual(luna, { input: 22960 - 21248, output: 1174, cache_read: 21248, cache_write: 0, cache_write_1h: 0 });
  assert.equal(report.usage.messages.unfinished, 0);
  assert.equal(report.usage.sessions.count, 1);
});

test('codex: a file from before usage records is counted from its running totals, once per response', async () => {
  // Codex before rust-v0.153 wrote no token_usage_record lines
  const old = lines(fixture('codex-session.jsonl')).filter((l) => !l.includes('"token_usage_record"')).join('\n');
  rollout('rollout-2026-10-09T16-02-11-a.jsonl', old);
  const { report } = await scanCodexUsage();
  assert.equal(report.usage.messages.count, 3);
  assert.equal(report.usage.tokens.output, 2479);
  assert.equal(report.usage.tokens.cached, 44672);
  assert.equal(report.usage.tokens.input, 63007 - 44672);
});

test('codex: a forked session copies its parent; the parent\'s response is counted once, at its own time', async () => {
  const fork = lines(fixture('codex-forked-copy.jsonl'));
  // The parent's own file: the lines the fork copied, at their original (earlier) time
  const parent = fork.slice(1, 9).map((l) => l.replace(/"timestamp":"2026-10-09T15:20:44\.\d{3}Z"/, '"timestamp":"2026-10-09T15:10:00.000Z"')).join('\n');
  rollout('rollout-2026-10-09T17-10-00-parent.jsonl', parent);
  rollout('rollout-2026-10-09T17-20-44-fork.jsonl', fork.join('\n'));
  const { report } = await scanCodexUsage();
  assert.equal(report.usage.messages.count, 2, 'the parent response and the fork\'s own response');
  const terra = report.usage.tokens.by_model['gpt-5.6-terra'];
  assert.equal(terra.output, 655 + 702);
  assert.equal(terra.cache_read, 3584 + 14976);
  assert.equal(report.period.start, '2026-10-09T15:10:00.000Z', 'the parent response keeps its own time, not the time of the copy');
});

test('codex: a forked session from before usage records does not count the copied part twice', async () => {
  const strip = (text: string[]) => text.filter((l) => !l.includes('"token_usage_record"'));
  const fork = strip(lines(fixture('codex-forked-copy.jsonl')));
  rollout('rollout-2026-10-09T17-10-00-parent.jsonl', fork.slice(1, 8).join('\n'));
  rollout('rollout-2026-10-09T17-20-44-fork.jsonl', fork.join('\n'));
  const { report } = await scanCodexUsage();
  assert.equal(report.usage.messages.count, 2);
  assert.equal(report.usage.tokens.output, 655 + 702);
});

test('codex: the same session archived and not, or packed and not, is read once', async () => {
  const text = fixture('codex-session.jsonl');
  rollout('rollout-2026-10-09T16-02-11-a.jsonl', text);
  rollout('rollout-2026-10-09T16-02-11-a.jsonl', text, 'archived_sessions');
  const { report } = await scanCodexUsage();
  assert.equal(report.usage.messages.count, 3);
});

test('codex: compressed sessions are read when Node can unpack them, and otherwise the total says it is a minimum', async () => {
  const pack = (zlib as unknown as { zstdCompressSync?: (b: Buffer) => Buffer }).zstdCompressSync;
  const text = fixture('codex-session.jsonl');
  if (pack) {
    rollout('rollout-2026-10-09T16-02-11-a.jsonl.zst', pack(Buffer.from(text)) as unknown as string);
    const { report } = await scanCodexUsage();
    assert.equal(report.usage.messages.count, 3);
    assert.notEqual(report.usage.incomplete, true);
  } else {
    rollout('rollout-2026-10-09T16-02-11-a.jsonl.zst', 'not readable here');
    const { report, progress } = await scanCodexUsage();
    assert.equal(report.usage.messages.count, 0);
    assert.equal(report.usage.incomplete, true);
    assert.ok(progress.errors.some((e) => /Node 22\.15/.test(e)));
  }
});

test('codex: Fast mode is filed apart, so it shows as unpriced instead of at the standard price', async () => {
  const text = lines(fixture('codex-session.jsonl')).map((l) =>
    l.includes('"thread_settings_applied"') ? l.replace('"thread_settings":{', '"thread_settings":{"service_tier":"priority",') : l).join('\n');
  rollout('rollout-2026-10-09T16-02-11-a.jsonl', text);
  const { report } = await scanCodexUsage();
  assert.ok(report.usage.tokens.by_model['gpt-5.6-luna-fast'], 'the turn after the switch to Fast');
  assert.ok(report.usage.tokens.by_model['gpt-5.6-terra'], 'the turn before it');
});

test('codex: --days leaves out older responses', async () => {
  rollout('rollout-2026-10-09T16-02-11-a.jsonl', fixture('codex-session.jsonl'));
  const { report } = await scanCodexUsage({ startDate: '2099-01-01' });
  assert.equal(report.usage.messages.count, 0);
});

// ---- Gemini CLI

test('gemini: each reply is counted once, rewound replies included, with thinking as output', async () => {
  chat('session-2026-10-09T09-14-3f6c2d1e.jsonl', fixture('gemini-session.jsonl'));
  const { report, progress } = await scanGeminiUsage();
  assert.equal(report.product, 'gemini-api');
  assert.equal(report.tool, 'Gemini CLI');
  assert.equal(report.usage.messages.count, 4, 'M1 is written twice (tool call finished) and counted once; M3 was rewound and still billed');
  assert.ok(progress.duplicatesSkipped >= 1);
  assert.deepEqual(report.usage.tokens.by_model['gemini-3-pro-preview'], {
    input: 9214 + (10391 - 8203), output: 38 + 412 + 296 + 157, cache_read: 8203, cache_write: 0, cache_write_1h: 0,
  });
  assert.deepEqual(report.usage.tokens.by_model['gemini-3.5-flash'], {
    input: 10802 + (10795 - 8192), output: 121 + 188 + 64, cache_read: 8192, cache_write: 0, cache_write_1h: 0,
  });
});

test('gemini: the older .json format is read too', async () => {
  chat('session-2026-04-10T08-31-a41d7e09.json', fixture('gemini-session.json'));
  const { report } = await scanGeminiUsage();
  assert.equal(report.usage.messages.count, 2);
  assert.deepEqual(report.usage.tokens.by_model['gemini-2.5-pro'], {
    input: 8873 + (9902 - 7911), output: 41 + 388 + 233 + 140, cache_read: 7911, cache_write: 0, cache_write_1h: 0,
  });
});

test('gemini: the same chat in two files (a .json and its .jsonl, or two project folders) is counted once', async () => {
  const text = fixture('gemini-session.jsonl');
  chat('session-2026-10-09T09-14-3f6c2d1e.jsonl', text);
  chat('session-2026-10-09T09-14-3f6c2d1e.jsonl', text, '6689668a49dc648b376787d8cde1d55e418968e916b4efa79d849fba7fb28a1f');
  const legacy = fixture('gemini-session.json');
  chat('session-2026-04-10T08-31-a41d7e09.json', legacy);
  // Resuming a .json chat writes a .jsonl copy of all of it, next to the .json
  const record = JSON.parse(legacy);
  const { messages, ...meta } = record;
  chat('session-2026-04-10T08-31-a41d7e09.jsonl', [meta, ...messages].map((m) => JSON.stringify(m)).join('\n') + '\n');
  const { report } = await scanGeminiUsage();
  assert.equal(report.usage.messages.count, 6);
});

test('gemini: files outside a chats folder are not chats', async () => {
  const folder = path.join(dir, 'gemini-home', '.gemini', 'tmp', 'acme-api');
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, 'logs.json'), fixture('gemini-session.json'));
  const { report } = await scanGeminiUsage();
  assert.equal(report.usage.messages.count, 0);
});

// ---- Cases found in review: each one failed before its fix

const noRecords = (text: string[]) => text.filter((l) => !l.includes('"token_usage_record"'));

test('codex: an old fork with no marker where its own part starts still counts its own response', async () => {
  const fork = noRecords(lines(fixture('codex-forked-copy.jsonl'))).filter((l) => !l.includes('"thread_settings_applied"'));
  rollout('rollout-p.jsonl', noRecords(lines(fixture('codex-forked-copy.jsonl'))).slice(1, 8).join('\n'));
  rollout('rollout-c.jsonl', fork.join('\n'));
  const { report } = await scanCodexUsage();
  assert.equal(report.usage.messages.count, 2);
  assert.equal(report.usage.tokens.output, 655 + 702);
});

test('codex: two separate old sessions with the same numbers are two sessions, not one', async () => {
  const s = noRecords(lines(fixture('codex-session.jsonl')));
  rollout('rollout-a.jsonl', s.join('\n'));
  rollout('rollout-b.jsonl', s.map((l) => l.replaceAll('019a7c3e-5b2d-7f41-9c8e-2d4b6a1f0e93', '019a7c3e-ffff-7f41-9c8e-2d4b6a1f0e93')).join('\n'));
  const { report } = await scanCodexUsage();
  assert.equal(report.usage.messages.count, 6);
  assert.equal(report.usage.sessions.count, 2);
});

test('codex: a subagent that copied its parent\'s running totals (but not its usage records) does not count them again', async () => {
  const fork = lines(fixture('codex-forked-copy.jsonl'));
  const parentId = '019a7b90-2c41-7d3a-b5e6-0f1e2d3c4b5a';
  const childMeta = fork[0]
    .replace(/"forked_from_id":"[^"]+",/, `"parent_thread_id":"${parentId}",`)
    .replace('"source":"cli"', `"source":{"subagent":{"thread_spawn":{"parent_thread_id":"${parentId}","depth":1}}}`);
  rollout('rollout-p.jsonl', fork.slice(1, 9).join('\n'));
  rollout('rollout-c.jsonl', [childMeta, ...noRecords(fork.slice(1, 9)), ...fork.slice(10)].join('\n'));
  const { report } = await scanCodexUsage();
  assert.equal(report.usage.messages.count, 2);
  assert.equal(report.usage.tokens.output, 655 + 702);
});

test('codex: a usage record without a response id does not hide the response', async () => {
  rollout('rollout-a.jsonl', fixture('codex-session.jsonl').replace(/"response_id":"resp_[0-9a-f]+"/g, '"response_id":""'));
  const { report } = await scanCodexUsage();
  assert.equal(report.usage.messages.count, 3);
});

test('a tool counts as used when its history is only in its other folder (archived Codex sessions, Gemini in the macOS sandbox)', async () => {
  const { readersWithData } = await import('../src/report.ts');
  const saved = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = path.join(dir, 'no-claude');
  try {
    rollout('rollout-a.jsonl', fixture('codex-session.jsonl'), 'archived_sessions');
    const chats = path.join(dir, 'gemini-home', '.cache', '.gemini', 'tmp', 'acme', 'chats');
    fs.mkdirSync(chats, { recursive: true });
    fs.writeFileSync(path.join(chats, 'session-2026-10-09T09-14-3f6c2d1e.jsonl'), fixture('gemini-session.jsonl'));
    assert.deepEqual(readersWithData().map((r) => r.key), ['codex', 'gemini']);
    assert.equal((await scanCodexUsage()).report.usage.messages.count, 3);
    assert.equal((await scanGeminiUsage()).report.usage.messages.count, 4);
  } finally {
    if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = saved;
  }
});

test('codex: a compressed file that cannot be unpacked is skipped, and the total says it is a minimum', async () => {
  rollout('rollout-a.jsonl.zst', 'this is not zstd');
  const { report } = await scanCodexUsage();
  assert.equal(report.usage.incomplete, true);
});

test('codex: an old session is still counted when a newer, unrelated session has the same numbers and a usage record', async () => {
  const session = lines(fixture('codex-session.jsonl'));
  // The same responses: once in an old file (no usage records) and once in a newer, separate session with records
  rollout('rollout-old.jsonl', noRecords(session).map((l) => l.replaceAll('019a7c3e-5b2d-7f41-9c8e-2d4b6a1f0e93', '019a7c3e-0000-7f41-9c8e-2d4b6a1f0e93')).join('\n'));
  rollout('rollout-new.jsonl', session.join('\n'));
  const { report } = await scanCodexUsage();
  assert.equal(report.usage.messages.count, 6);
  assert.equal(report.usage.sessions.count, 2);
});
