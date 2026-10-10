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
    // `node --test` in a real terminal passes FORCE_COLOR=1 to what it runs, and that beats NO_COLOR
    FORCE_COLOR: '0',
    NO_COLOR: '1',
  };
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

function run(args: string[], input?: string) {
  return spawnSync(process.execPath, ['--import', 'tsx', ENTRY, ...args], { env, encoding: 'utf8', input, timeout: 30_000, cwd: CLI_ROOT });
}

// scan writes one report per tool. These tests only have Claude Code history.
const claudeIn = (json: any) => json.reports.find((r: any) => r.tool === 'Claude Code');
const repliesIn = (args: string[]) => claudeIn(JSON.parse(run(['scan', '--json', '--no-save', ...args]).stdout)).usage.messages.count;

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
  assert.equal(claudeIn(JSON.parse(fs.readFileSync(out, 'utf8'))).usage.messages.count, 3);
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

test('colour never leaks into the output, even when the test runner forces it on', () => {
  const r = spawnSync(process.execPath, ['--import', 'tsx', ENTRY, 'analyze', path.join(dir, 'missing.json')], {
    env: { ...env, FORCE_COLOR: '0' }, encoding: 'utf8', cwd: CLI_ROOT,
  });
  assert.doesNotMatch(r.stdout + r.stderr, /\u001b\[/);
});

test('"help" and "help <command>" work, and a mistyped command names the real ones', () => {
  const help = run(['help']);
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /scan/);
  const helpScan = run(['help', 'scan']);
  assert.equal(helpScan.status, 0, helpScan.stderr);
  assert.match(helpScan.stdout, /Usage: llm-usage-analyzer scan/);

  const typo = run(['scna']);
  assert.notEqual(typo.status, 0);
  assert.match(typo.stderr, /unknown command 'scna'/);
  assert.match(typo.stderr, /scan, analyze, serve, statusline, limits/);
});

test('an option written before a command is an error, not silently ignored', () => {
  const r = run(['--days', '2', 'scan', '--json', '--no-save']);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /--days 2 must come after the command, for example: llm-usage-analyzer scan --days 2/);
  assert.equal(r.stdout, '', 'the scan did not run');
  const port = run(['--port', '4555', 'serve']);
  assert.notEqual(port.status, 0);
  assert.match(port.stderr, /--port 4555 must come after the command/);
  // after the command it still works
  assert.equal(repliesIn(['--days', '5']), 2);
});

test('numbers must be plain digits: 0x50, 1e3, 3456abc, 08 and -1 are all refused', () => {
  for (const bad of ['0x50', '1e3', '3456abc', '08', '-1', ' 80', '']) {
    const r = run(['--port', bad, '--no-open']);
    assert.notEqual(r.status, 0, `port [${bad}]`);
    assert.match(r.stdout + r.stderr, /--port must be a whole number/, `port [${bad}]`);
  }
  for (const bad of ['2abc', '1e0', '0x1', '0']) {
    const r = run(['scan', '--days', bad, '--no-save']);
    assert.notEqual(r.status, 0, `days [${bad}]`);
    assert.match(r.stdout + r.stderr, /--days must be a whole number/, `days [${bad}]`);
  }
});

test('limits --plan only accepts the real plan names, not names that every object has', () => {
  for (const name of ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'PRO2']) {
    const r = run(['limits', '--plan', name]);
    assert.notEqual(r.status, 0, name);
    assert.match(r.stderr, /Tell me your current plan/, name);
    assert.doesNotMatch(r.stdout + r.stderr, /\[native code\]|\[object Object\]|Something went wrong/, name);
  }
  assert.equal(run(['limits', '--plan', 'MAX5X']).status, 0, 'case does not matter');
});

test('the status line always prints one line and exits 0, whatever it is sent', () => {
  const cases: Array<[string, string]> = [
    ['no input at all', ''],
    ['text', 'hello'],
    ['broken JSON', '{"rate_limits":'],
    ['an empty object', '{}'],
    ['the wrong types', '{"rate_limits":{"five_hour":{"used_percentage":"high"},"seven_day":null}}'],
    ['a huge message', '{"x":"' + 'a'.repeat(3 * 1024 * 1024) + '"}'],
  ];
  for (const [name, input] of cases) {
    const r = run(['statusline'], input);
    assert.equal(r.status, 0, name);
    assert.equal(r.stdout.trim(), '5h — · 7d —', name);
  }
  assert.equal(run(['statusline'], '{"rate_limits":{"five_hour":{"used_percentage":12.4},"seven_day":{"used_percentage":41}}}').stdout.trim(), '5h 12% · 7d 41%');
});

test('the status line answers as soon as the message is complete, without waiting for the pipe to close', async () => {
  const child = spawn(process.execPath, ['--import', 'tsx', ENTRY, 'statusline'], { env, cwd: CLI_ROOT, stdio: ['pipe', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (d) => (out += d));
  const started = Date.now();
  child.stdin.write('{"rate_limits":{"five_hour":{"used_percentage":7}}}');   // and stdin stays open
  const code: number = await new Promise((resolve) => child.on('close', (c) => resolve(c ?? -1)));
  assert.equal(code, 0);
  assert.equal(out.trim(), '5h 7% · 7d —');
  assert.ok(Date.now() - started < 1400, 'it did not sit out the 1.5 second wait');
});

test('the program keeps running when its output pipe is closed (for example, "| head -1")', async () => {
  const child = spawn(process.execPath, ['--import', 'tsx', ENTRY, '--no-open', '--port', '0'], { env, cwd: CLI_ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    const port: number = await new Promise((resolve, reject) => {
      let text = '';
      const timer = setTimeout(() => reject(new Error('the server did not start')), 15_000);
      child.stdout.on('data', (d) => {
        text += d;
        const m = /http:\/\/localhost:(\d+)\//.exec(text);
        if (m) { clearTimeout(timer); resolve(Number(m[1])); }
      });
    });
    // The reader goes away
    child.stdout.destroy();
    child.stderr.destroy();
    // Every read of the usage prints a line to the terminal, which is what failed once the reader had gone
    for (let i = 0; i < 3; i++) {
      const res = await fetch(`http://127.0.0.1:${port}/api/usage`);
      assert.equal(res.status, 200, `request ${i + 1}`);
      await new Promise((r) => setTimeout(r, 2200));   // past the short cache, so each request prints
    }
    assert.equal(child.exitCode, null, 'still running');
  } finally {
    child.kill();
  }
});

test('a time zone change between two scans does not double count (through the real command)', () => {
  const home = path.join(dir, 'tzhome');
  const base = { ...env, LLM_USAGE_HOME: home };
  const scan = (tz: string, extra: string[]) => spawnSync(process.execPath, ['--import', 'tsx', ENTRY, 'scan', '--json', ...extra], { env: { ...base, TZ: tz }, encoding: 'utf8', cwd: CLI_ROOT });
  const first = claudeIn(JSON.parse(scan('America/New_York', []).stdout));
  const again = claudeIn(JSON.parse(scan('Asia/Tokyo', ['--no-save']).stdout));
  assert.equal(again.usage.messages.count, first.usage.messages.count);
});

test('scan warns before writing the report into a git folder, and not otherwise', () => {
  const repo = path.join(dir, 'repo');
  fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
  const inside = run(['scan', '--no-save', '-o', path.join(repo, 'usage_report.json')]);
  assert.equal(inside.status, 0, inside.stderr);
  const warn = inside.stdout.indexOf('about to be written into a git repository');
  const saved = inside.stdout.indexOf('Saved:');
  assert.ok(warn >= 0 && saved > warn, 'the warning comes first');
  const plainFolder = path.join(dir, 'plain');
  fs.mkdirSync(plainFolder);
  const elsewhere = run(['scan', '--no-save', '-o', path.join(plainFolder, 'usage_report.json')]);
  assert.doesNotMatch(elsewhere.stdout, /git repository/);
});
