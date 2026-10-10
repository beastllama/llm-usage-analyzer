import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isAllowedHost, allowedOrigin, DEFAULT_ORIGINS } from '../src/commands/serve.ts';

test('only this server\'s own host names are accepted (blocks DNS rebinding)', () => {
  assert.equal(isAllowedHost('localhost:3456', 3456), true);
  assert.equal(isAllowedHost('127.0.0.1:3456', 3456), true);
  assert.equal(isAllowedHost('evil.example:3456', 3456), false);
  assert.equal(isAllowedHost('localhost:9999', 3456), false);
  assert.equal(isAllowedHost(undefined, 3456), false);
});

test('CORS is granted only to allowlisted dashboards, never to a wildcard', () => {
  assert.equal(allowedOrigin('http://localhost:5173', DEFAULT_ORIGINS), 'http://localhost:5173');
  assert.equal(allowedOrigin('https://evil.example', DEFAULT_ORIGINS), null);
  assert.equal(allowedOrigin('http://localhost:5173.evil.example', DEFAULT_ORIGINS), null);
  assert.equal(allowedOrigin(undefined, DEFAULT_ORIGINS), null);
  assert.equal(allowedOrigin('https://dashboard.example', [...DEFAULT_ORIGINS, 'https://dashboard.example']), 'https://dashboard.example');
});

// ---- Serving the bundled dashboard ----
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {
  startServer, resolveStaticFile, injectServerMarker, CONTENT_SECURITY_POLICY, type RunningServer,
} from '../src/commands/serve.ts';

function makeWeb(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-web-'));
  fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html><html><head><title>t</title></head><body>app</body></html>');
  fs.mkdirSync(path.join(dir, 'assets'));
  fs.writeFileSync(path.join(dir, 'assets', 'app.js'), 'console.log(1)');
  // A secret next to the web folder, to prove it cannot be reached
  fs.writeFileSync(path.join(dir, '..', 'llm-secret.txt'), 'secret');
  return dir;
}

/** Make a request with a chosen Host header (fetch does not allow that). */
function request(port: number, urlPath: string, headers: Record<string, string> = {}, method = 'GET'):
  Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: urlPath, method, headers: { Host: `localhost:${port}`, ...headers } }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('static paths never leave the dashboard folder', () => {
  const web = makeWeb();
  assert.ok(resolveStaticFile(web, '/assets/app.js')?.endsWith('app.js'));
  assert.ok(resolveStaticFile(web, '/')?.endsWith('index.html'));
  assert.ok(resolveStaticFile(web, '/some/page')?.endsWith('index.html'), 'a path with no extension is the app');
  assert.equal(resolveStaticFile(web, '/missing.js'), null);
  assert.equal(resolveStaticFile(web, '/../llm-secret.txt'), null);
  assert.equal(resolveStaticFile(web, '/%2e%2e/llm-secret.txt'), null);
  assert.equal(resolveStaticFile(web, '/..%2fllm-secret.txt'), null);
  assert.equal(resolveStaticFile(web, '/assets/%00.js'), null);
  assert.equal(resolveStaticFile(web, '/%zz'), null);
});

test('a link inside the dashboard folder that points outside it is refused', () => {
  const web = makeWeb();
  const secret = path.join(path.dirname(web), 'llm-secret.txt');
  try { fs.symlinkSync(secret, path.join(web, 'leak.txt')); } catch { return; }
  assert.equal(resolveStaticFile(web, '/leak.txt'), null);
});

test('the served page is marked, and the marker goes inside <head>', () => {
  const out = injectServerMarker('<html><head><title>t</title></head><body></body></html>');
  assert.match(out, /<meta name="llm-usage-server" content="1" \/>\s*<\/head>/);
});

test('the page policy only lets the page talk to its own address', () => {
  assert.match(CONTENT_SECURITY_POLICY, /connect-src 'self'(;|$)/);
  assert.match(CONTENT_SECURITY_POLICY, /script-src 'self'(;|$)/);
  assert.ok(!/\*/.test(CONTENT_SECURITY_POLICY), 'no wildcards');
});

test('the server hands out the dashboard with the policy, and keeps the Host check', async () => {
  const web = makeWeb();
  const prev = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = path.join(web, 'no-such-claude-dir');
  let running: RunningServer | undefined;
  try {
    running = await startServer({ port: 0, webDir: web, quiet: true });
    const { port } = running;

    const page = await request(port, '/');
    assert.equal(page.status, 200);
    assert.match(String(page.headers['content-type']), /text\/html/);
    assert.equal(page.headers['content-security-policy'], CONTENT_SECURITY_POLICY);
    assert.match(page.body, /llm-usage-server/);

    const asset = await request(port, '/assets/app.js');
    assert.equal(asset.status, 200);
    assert.match(String(asset.headers['content-type']), /javascript/);
    assert.equal(asset.headers['x-content-type-options'], 'nosniff');

    const noData = await request(port, '/api/usage');
    assert.equal(noData.status, 404, 'no Claude history is a 404, not a crash');

    const health = await request(port, '/api/health');
    assert.equal(health.status, 200);

    const traversal = await request(port, '/..%2f..%2fllm-secret.txt');
    assert.equal(traversal.status, 404);

    const rebinding = await request(port, '/', { Host: `evil.example:${port}` });
    assert.equal(rebinding.status, 403);

    const post = await request(port, '/api/usage', {}, 'POST');
    assert.equal(post.status, 405);
  } finally {
    if (prev === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = prev;
    await running?.close();
  }
});

test('with Claude history present, /api/usage returns its report in a bundle', async () => {
  const web = makeWeb();
  const cfg = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-claude-'));
  const proj = path.join(cfg, 'projects', 'p1');
  fs.mkdirSync(proj, { recursive: true });
  const ts = new Date().toISOString();
  fs.writeFileSync(path.join(proj, 's.jsonl'), JSON.stringify({
    type: 'assistant', timestamp: ts, requestId: 'r1',
    message: { id: 'm1', model: 'claude-sonnet-5-5', usage: { input_tokens: 10, output_tokens: 20 } },
  }) + '\n');

  const prev = { c: process.env.CLAUDE_CONFIG_DIR, h: process.env.LLM_USAGE_HOME };
  process.env.CLAUDE_CONFIG_DIR = cfg;
  process.env.LLM_USAGE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-home-'));
  let running: RunningServer | undefined;
  try {
    running = await startServer({ port: 0, webDir: web, quiet: true });
    const res = await request(running.port, '/api/usage');
    assert.equal(res.status, 200);
    const bundle = JSON.parse(res.body);
    assert.equal(bundle.format, 'llm-usage-bundle');
    const report = bundle.reports.find((r: any) => r.tool === 'Claude Code');
    assert.equal(report.product, 'claude');
    assert.equal(report.usage.messages.count, 1);
    assert.equal(report.usage.tokens.output, 20);
  } finally {
    if (prev.c === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = prev.c;
    if (prev.h === undefined) delete process.env.LLM_USAGE_HOME; else process.env.LLM_USAGE_HOME = prev.h;
    await running?.close();
  }
});

test('the package is named and wired for npx, and ships the dashboard', async () => {
  const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(pkg.name, 'llm-usage-analyzer');
  assert.deepEqual(Object.keys(pkg.bin), ['llm-usage-analyzer']);
  assert.ok(pkg.files.includes('web'));
});

// ---- Hardening ----
import { normalizeOrigin, browserCommand } from '../src/commands/serve.ts';

// These tests use Claude Code history only. Codex and Gemini CLI history on this computer must not be read.
process.env.CODEX_HOME = path.join(os.tmpdir(), `llm-no-codex-${process.pid}`);
process.env.GEMINI_CLI_HOME = path.join(os.tmpdir(), `llm-no-gemini-${process.pid}`);

test('--origin values must be a plain origin: no path, no *, no "null", no other scheme', () => {
  assert.equal(normalizeOrigin('https://example.com'), 'https://example.com');
  assert.equal(normalizeOrigin('https://example.com/'), 'https://example.com');
  assert.equal(normalizeOrigin('http://localhost:8080'), 'http://localhost:8080');
  for (const bad of ['null', '*', 'example.com', 'file:///tmp/x', 'javascript:alert(1)', 'https://example.com/app', 'https://example.com?x=1', 'https://user:pw@example.com', '']) {
    assert.equal(normalizeOrigin(bad), null, bad);
  }
});

test('the one-command launch lets no other page read the data; the dev server flag lets the dashboard ports in', async () => {
  const web = makeWeb();
  let running: RunningServer | undefined;
  try {
    running = await startServer({ port: 0, webDir: web, quiet: true, devOrigins: false });
    const refused = await request(running.port, '/api/health', { Origin: 'http://localhost:5173' });
    assert.equal(refused.headers['access-control-allow-origin'], undefined);
    await running.close();

    running = await startServer({ port: 0, webDir: web, quiet: true });
    const allowed = await request(running.port, '/api/health', { Origin: 'http://localhost:5173' });
    assert.equal(allowed.headers['access-control-allow-origin'], 'http://localhost:5173');
  } finally {
    await running?.close();
  }
});

test('a request that the browser marks as coming from another website is refused', async () => {
  const web = makeWeb();
  let running: RunningServer | undefined;
  try {
    running = await startServer({ port: 0, webDir: web, quiet: true });
    const r = await request(running.port, '/api/usage', { 'Sec-Fetch-Site': 'cross-site' });
    assert.equal(r.status, 403);
    const same = await request(running.port, '/api/health', { 'Sec-Fetch-Site': 'same-origin' });
    assert.equal(same.status, 200);
  } finally {
    await running?.close();
  }
});

test('the missing-history answer does not reveal where the history folder is', async () => {
  const web = makeWeb();
  const prev = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = path.join(web, 'no-such-claude-dir');
  let running: RunningServer | undefined;
  try {
    running = await startServer({ port: 0, webDir: web, quiet: true });
    const r = await request(running.port, '/api/usage');
    assert.equal(r.status, 404);
    assert.ok(!r.body.includes(web) && !r.body.includes('no-such-claude-dir'));
  } finally {
    if (prev === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = prev;
    await running?.close();
  }
});

test('many requests at once cost one scan, and they all get the answer', async () => {
  const web = makeWeb();
  const cfg = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-claude-'));
  const proj = path.join(cfg, 'projects', 'p1');
  fs.mkdirSync(proj, { recursive: true });
  fs.writeFileSync(path.join(proj, 's.jsonl'), JSON.stringify({
    type: 'assistant', timestamp: new Date().toISOString(),
    message: { id: 'm1', model: 'claude-sonnet-5-5', stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 20 } },
  }) + '\n');
  const prev = { c: process.env.CLAUDE_CONFIG_DIR, h: process.env.LLM_USAGE_HOME };
  process.env.CLAUDE_CONFIG_DIR = cfg;
  process.env.LLM_USAGE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-home-'));
  let running: RunningServer | undefined;
  try {
    running = await startServer({ port: 0, webDir: web, quiet: true });
    const port = running.port;
    const answers = await Promise.all(Array.from({ length: 30 }, () => request(port, '/api/usage')));
    assert.ok(answers.every((a) => a.status === 200));
    assert.ok(answers.every((a) => JSON.parse(a.body).reports[0].usage.messages.count === 1));

    // A change shows up once the short reuse window has passed
    fs.appendFileSync(path.join(proj, 's.jsonl'), JSON.stringify({
      type: 'assistant', timestamp: new Date().toISOString(),
      message: { id: 'm2', model: 'claude-sonnet-5-5', stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } },
    }) + '\n');
    await new Promise((r) => setTimeout(r, 2200));
    assert.equal(JSON.parse((await request(port, '/api/usage')).body).reports[0].usage.messages.count, 2);
  } finally {
    if (prev.c === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = prev.c;
    if (prev.h === undefined) delete process.env.LLM_USAGE_HOME; else process.env.LLM_USAGE_HOME = prev.h;
    await running?.close();
  }
});

test('a failure inside one request is an error answer, and the server keeps running', async () => {
  const web = makeWeb();
  let running: RunningServer | undefined;
  try {
    running = await startServer({ port: 0, webDir: web, quiet: true });
    // Take the dashboard folder away while the server runs
    fs.rmSync(web, { recursive: true, force: true });
    const broken = await request(running.port, '/');
    assert.ok(broken.status === 500 || broken.status === 404, `got ${broken.status}`);
    const health = await request(running.port, '/api/health');
    assert.equal(health.status, 200, 'the server is still up');
  } finally {
    await running?.close();
  }
});

test('responses say they are for this origin only', async () => {
  const web = makeWeb();
  let running: RunningServer | undefined;
  try {
    running = await startServer({ port: 0, webDir: web, quiet: true });
    assert.equal((await request(running.port, '/')).headers['cross-origin-resource-policy'], 'same-origin');
    assert.equal((await request(running.port, '/api/health')).headers['cross-origin-resource-policy'], 'same-origin');
  } finally {
    await running?.close();
  }
});

test('a dashboard on the allowlist can read the data even though the browser calls it "cross-site"', async () => {
  const web = makeWeb();
  let running: RunningServer | undefined;
  try {
    // 127.0.0.1:5173 is "cross-site" to localhost:<port>, and so is a dashboard hosted on another domain
    running = await startServer({ port: 0, webDir: web, quiet: true, origins: ['https://dashboard.example'] });
    for (const origin of ['http://127.0.0.1:5173', 'http://localhost:5173', 'https://dashboard.example']) {
      const r = await request(running.port, '/api/health', { Origin: origin, 'Sec-Fetch-Site': 'cross-site' });
      assert.equal(r.status, 200, origin);
      assert.equal(r.headers['access-control-allow-origin'], origin, origin);
    }
    // an origin that is not on the list is still refused, with or without the browser's marker
    const other = await request(running.port, '/api/health', { Origin: 'https://evil.example', 'Sec-Fetch-Site': 'cross-site' });
    assert.equal(other.status, 403);
    assert.equal(other.headers['access-control-allow-origin'], undefined);
    // and so is a cross-site request with no origin at all (a script tag, an image, a link)
    const bare = await request(running.port, '/api/usage', { 'Sec-Fetch-Site': 'cross-site' });
    assert.equal(bare.status, 403);
  } finally {
    await running?.close();
  }
});

test('a refusal carries the same protective headers as any other answer', async () => {
  const web = makeWeb();
  let running: RunningServer | undefined;
  try {
    running = await startServer({ port: 0, webDir: web, quiet: true });
    const badHost = await request(running.port, '/api/usage', { Host: 'evil.example' });
    const crossSite = await request(running.port, '/api/usage', { 'Sec-Fetch-Site': 'cross-site' });
    for (const r of [badHost, crossSite]) {
      assert.equal(r.status, 403);
      assert.equal(r.headers['x-content-type-options'], 'nosniff');
      assert.equal(r.headers['referrer-policy'], 'no-referrer');
      assert.equal(r.headers['cross-origin-resource-policy'], 'same-origin');
    }
  } finally {
    await running?.close();
  }
});

test('the browser is opened by its full path, so a planted file in the current folder is never run', () => {
  assert.deepEqual(browserCommand('http://localhost:3456/', 'darwin'), ['/usr/bin/open', ['http://localhost:3456/']]);
  assert.deepEqual(browserCommand('http://localhost:3456/', 'linux'), ['xdg-open', ['http://localhost:3456/']]);
  const [win, args] = browserCommand('http://localhost:3456/', 'win32', { SystemRoot: 'D:\\WINNT' });
  assert.equal(win, 'D:\\WINNT\\System32\\rundll32.exe');
  assert.deepEqual(args, ['url.dll,FileProtocolHandler', 'http://localhost:3456/']);
  assert.equal(browserCommand('x', 'win32', {})[0], 'C:\\Windows\\System32\\rundll32.exe');
  assert.equal(browserCommand('x', 'win32', { windir: 'E:\\Win' })[0], 'E:\\Win\\System32\\rundll32.exe');
});

test('aborted downloads of a big file do not leave files open', { skip: !fs.existsSync('/proc/self/fd') }, async () => {
  const web = makeWeb();
  fs.writeFileSync(path.join(web, 'assets', 'big.js'), Buffer.alloc(60 * 1024 * 1024, 97));
  const openFiles = () => fs.readdirSync('/proc/self/fd').length;
  let running: RunningServer | undefined;
  try {
    running = await startServer({ port: 0, webDir: web, quiet: true });
    const before = openFiles();
    await Promise.all(Array.from({ length: 40 }, () => new Promise<void>((resolve) => {
      const req = http.request({ host: '127.0.0.1', port: running!.port, path: '/assets/big.js', headers: { Host: `localhost:${running!.port}` } }, (res) => {
        res.once('data', () => { req.destroy(); resolve(); });
      });
      req.on('error', () => resolve());
      req.end();
    })));
    await new Promise((r) => setTimeout(r, 500));
    const after = openFiles();
    assert.ok(after - before < 10, `${after - before} files were left open`);
  } finally {
    await running?.close();
  }
});
