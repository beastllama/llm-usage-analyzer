import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// These run the real command (from source) the way a user would, so a flag that never reaches its command is caught.
const ENTRY = path.resolve('src/index.ts');
const CLI_ROOT = path.resolve('.');
let dir: string;
let env: NodeJS.ProcessEnv;

const DAY = 24 * 60 * 60 * 1000;
const reply = (id: string, when: Date) => JSON.stringify({
  sessionId: 's1',
  timestamp: when.toISOString(),
  message: { id, model: 'claude-sonnet-5-5', stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 5 } },
});

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-usage-cli-'));
  const projects = path.join(dir, 'claude', 'projects', 'p1');
  fs.mkdirSync(projects, { recursive: true });
  const now = Date.now();
  // One reply from today, one from 3 days ago, one from 20 days ago
  fs.writeFileSync(path.join(projects, 's1.jsonl'), [
    reply('a', new Date(now - 60 * 60 * 1000)),
    reply('b', new Date(now - 3 * DAY)),
    reply('c', new Date(now - 20 * DAY)),
  ].join('\n') + '\n');
  env = {
    ...process.env,
    CLAUDE_CONFIG_DIR: path.join(dir, 'claude'),
    LLM_USAGE_HOME: path.join(dir, 'home'),
    NO_COLOR: '1',
  };
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

function run(args: string[], input?: string) {
  return spawnSync(process.execPath, ['--import', 'tsx', ENTRY, ...args], { env, encoding: 'utf8', input, timeout: 30_000, cwd: CLI_ROOT });
}

const repliesIn = (args: string[]) => JSON.parse(run(['scan', '--json', '--no-save', ...args]).stdout).usage.messages.count;

test('scan --days reaches the scan command, so it changes what is counted', () => {
  assert.equal(repliesIn([]), 3);
  assert.equal(repliesIn(['--days', '30']), 3);
  assert.equal(repliesIn(['--days', '5']), 2);
  assert.equal(repliesIn(['--days', '1']), 1);
});

test('--days must be a whole number of 1 or more, on every command that takes it', () => {
  for (const args of [['scan', '--days', 'abc'], ['scan', '--days', '0'], ['scan', '--days', '-1'], ['limits', '--plan', 'pro', '--days', 'abc'], ['--days', 'abc', '--no-open']]) {
    const r = run(args);
    assert.notEqual(r.status, 0, args.join(' '));
    assert.match(r.stdout + r.stderr, /--days must be a whole number/, args.join(' '));
  }
});

test('limits --days and --plan reach the limits command, and --days 10 means 10', () => {
  const r = run(['limits', '-p', 'pro', '--days', '10']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /last 10 days/);
  assert.doesNotMatch(r.stdout, /last 30 days|last 100 days/);
});

test('--port must be a whole number from 0 to 65535', () => {
  for (const args of [['--port', 'abc', '--no-open'], ['--port', '70000', '--no-open'], ['serve', '--port', 'abc']]) {
    const r = run(args);
    assert.notEqual(r.status, 0, args.join(' '));
    assert.match(r.stdout + r.stderr, /--port must be a whole number/, args.join(' '));
  }
});

test('a mistyped command is an error, and does not start the dashboard', () => {
  const r = run(['scna']);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /too many arguments|unknown command/i);
  assert.doesNotMatch(r.stdout, /Open http/);
});

test('serve --port reaches the serve command and the server uses it', async () => {
  const child = spawn(process.execPath, ['--import', 'tsx', ENTRY, 'serve', '--port', '0'], { env, cwd: CLI_ROOT });
  let out = '';
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (out += d));
  try {
    const deadline = Date.now() + 20_000;
    let port: number | null = null;
    while (Date.now() < deadline && port === null) {
      await new Promise((r) => setTimeout(r, 100));
      const m = /http:\/\/localhost:(\d+)\//.exec(out);
      if (m) port = Number(m[1]);
    }
    assert.ok(port, `the server did not say where it is. It said: ${out}`);
    assert.notEqual(port, 3456, 'port 0 means any free port. 3456 would mean the flag was swallowed');
    const health = await fetch(`http://127.0.0.1:${port}/api/health`);
    assert.equal(health.status, 200);
  } finally {
    child.kill();
  }
});

test('the status line shows each window on its own when the other is missing', () => {
  assert.equal(run(['statusline'], JSON.stringify({ rate_limits: { seven_day: { used_percentage: 41.2 } } })).stdout.trim(), '5h — · 7d 41%');
  assert.equal(run(['statusline'], JSON.stringify({ rate_limits: { five_hour: { used_percentage: 12 } } })).stdout.trim(), '5h 12% · 7d —');
  assert.equal(run(['statusline'], 'not json').stdout.trim(), '5h — · 7d —');
});

test('scan still writes its report when the history folder cannot be written, and says so', () => {
  env.LLM_USAGE_HOME = '/dev/null/cannot-exist';
  const out = path.join(dir, 'report.json');
  const r = run(['scan', '-o', out]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /Could not save your history/);
  assert.equal(JSON.parse(fs.readFileSync(out, 'utf8')).usage.messages.count, 3);
});

test('scan writes the report with owner-only permissions and replaces a link instead of writing through it', () => {
  const victim = path.join(dir, 'victim.txt');
  fs.writeFileSync(victim, 'keep me');
  const out = path.join(dir, 'report.json');
  fs.symlinkSync(victim, out);
  const r = run(['scan', '-o', out]);
  // Writing through a link is refused
  assert.notEqual(r.status, 0);
  assert.equal(fs.readFileSync(victim, 'utf8'), 'keep me');

  fs.unlinkSync(out);
  assert.equal(run(['scan', '-o', out]).status, 0);
  if (process.platform !== 'win32') assert.equal(fs.statSync(out).mode & 0o777, 0o600);
});

test('model names with terminal escape codes are printed without them', () => {
  const projects = path.join(dir, 'claude', 'projects', 'p1');
  fs.writeFileSync(path.join(projects, 'evil.jsonl'), JSON.stringify({
    sessionId: 's1', timestamp: new Date().toISOString(),
    message: { id: 'evil', model: 'bad\u001b]0;pwned\u0007name', stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } },
  }) + '\n');
  const r = run(['scan', '-o', path.join(dir, 'r.json')]);
  assert.equal(r.status, 0);
  assert.doesNotMatch(r.stdout, /\u001b\]0;/);
  assert.match(r.stdout, /bad\]0;pwnedname/);
});

test('analyze says "at least" and never recommends leaving the plan when many replies were cut short', () => {
  const report = {
    provider: 'anthropic', source: 'local_agent',
    period: { start: '2026-09-01T00:00:00.000Z', end: '2026-09-30T23:00:00.000Z' },
    plan: { name: 'Not set', price_usd: 0, type: 'subscription' },
    usage: {
      tokens: { input: 1_000_000, output: 1000, by_model: { 'claude-sonnet-5-5': { input: 1_000_000, output: 1000 } } },
      messages: { count: 100, unfinished: 90, by_day: [] },
      sessions: { count: 1 },
    },
  };
  const file = path.join(dir, 'cut.json');
  fs.writeFileSync(file, JSON.stringify(report));
  const r = run(['analyze', file]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /at least/);
  assert.match(r.stdout, /can't tell/);
  assert.doesNotMatch(r.stdout, /more than pay-as-you-go/);
});

test('scan only says the output is a minimum when some replies were really cut short', () => {
  const clean = run(['scan', '-o', path.join(dir, 'clean.json')]);
  assert.equal(clean.status, 0, clean.stderr);
  assert.match(clean.stdout, /Output:\s+\S+\s*\n/, 'the output line is shown');
  assert.doesNotMatch(clean.stdout, /a minimum/);

  // A reply that was logged with no stop reason, so its output count may be cut short
  const projects = path.join(dir, 'claude', 'projects', 'p1');
  fs.writeFileSync(path.join(projects, 'cut.jsonl'), JSON.stringify({
    sessionId: 's2', timestamp: new Date().toISOString(),
    message: { id: 'cut', model: 'claude-sonnet-5-5', stop_reason: null, usage: { input_tokens: 10, output_tokens: 3 } },
  }) + '\n');
  const cut = run(['scan', '-o', path.join(dir, 'cut.json')]);
  assert.equal(cut.status, 0, cut.stderr);
  assert.match(cut.stdout, /Output:.*a minimum: some replies were logged before they finished/);
  assert.match(cut.stdout, /1 reply was logged before finishing/);
});
