import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ensurePrivateFolder, appendPrivateLine, writePrivateFile, plain } from '../src/fsafe.ts';

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-usage-fsafe-')); });
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const mode = (p: string) => fs.statSync(p).mode & 0o777;
const posix = { skip: process.platform === 'win32' };

test('our own data folder is made private even when it already exists with looser rights', posix, () => {
  const folder = path.join(dir, '.llm-usage');
  fs.mkdirSync(folder, { mode: 0o755 });
  fs.chmodSync(folder, 0o755);
  ensurePrivateFolder(folder);
  assert.equal(mode(folder), 0o700);
  // and a new one is created private
  ensurePrivateFolder(path.join(dir, 'new', 'deep'));
  assert.equal(mode(path.join(dir, 'new', 'deep')), 0o700);
});

test('an existing readings file that is open to others is made private when a line is added', posix, () => {
  const file = path.join(dir, 'limits.jsonl');
  fs.writeFileSync(file, '{"old":1}\n', { mode: 0o644 });
  fs.chmodSync(file, 0o644);
  appendPrivateLine(file, '{"new":2}\n');
  assert.equal(mode(file), 0o600);
  assert.equal(fs.readFileSync(file, 'utf8'), '{"old":1}\n{"new":2}\n');
});

test('writing a report into a folder the user chose does not change that folder\'s rights', posix, () => {
  const folder = path.join(dir, 'mine');
  fs.mkdirSync(folder, { mode: 0o755 });
  fs.chmodSync(folder, 0o755);
  writePrivateFile(path.join(folder, 'usage_report.json'), '{}');
  assert.equal(mode(folder), 0o755, 'only the tool\'s own folder is tightened');
  assert.equal(mode(path.join(folder, 'usage_report.json')), 0o600);
});

test('control characters are removed from text that came from the disk', () => {
  assert.equal(plain('a\u001b]0;x\u0007b\nc\u009fd'), 'a]0;xbcd');
});
