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

test('with Claude history present, /api/usage returns a report', async () => {
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
    const report = JSON.parse(res.body);
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
  assert.deepEqual(Object.keys(pkg.bin).sort(), ['llm-usage', 'llm-usage-analyzer']);
  assert.ok(pkg.files.includes('web'));
});
