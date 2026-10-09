import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// The page is served two ways: by the command (packages/cli/src/commands/serve.ts) and by Vercel (vercel.json).
// Both must send the same Content-Security-Policy, so a change in one cannot quietly leave the other behind.
// (This reads the source text, because the web app's tests do not install the command's packages.)
const serveSource = readFileSync('packages/cli/src/commands/serve.ts', 'utf8');
const block = serveSource.slice(serveSource.indexOf('export const CONTENT_SECURITY_POLICY'));
const cliPolicy = [...block.slice(0, block.indexOf("].join('; ')")).matchAll(/"([^"]+)"/g)].map((m) => m[1]).join('; ');

const vercel = JSON.parse(readFileSync('vercel.json', 'utf8'));
const headers: Array<{ key: string; value: string }> = vercel.headers[0].headers;
const header = (name: string) => headers.find((h) => h.key.toLowerCase() === name.toLowerCase())?.value;

test('Vercel sends the same Content-Security-Policy as the command', () => {
  assert.ok(cliPolicy.includes("connect-src 'self'"), 'the policy was read from serve.ts');
  assert.equal(header('Content-Security-Policy'), cliPolicy);
});

test('the policy has no wildcard and no remote source', () => {
  assert.ok(!/\*|https?:/.test(cliPolicy));
  for (const directive of ["default-src 'self'", "script-src 'self'", "connect-src 'self'", "object-src 'none'", "frame-ancestors 'none'", "base-uri 'none'", "form-action 'none'"]) {
    assert.ok(cliPolicy.split('; ').includes(directive), `missing: ${directive}`);
  }
});

test('Vercel also sends the other protective headers, for every path', () => {
  assert.equal(vercel.headers[0].source, '/(.*)');
  assert.equal(header('X-Content-Type-Options'), 'nosniff');
  assert.equal(header('Referrer-Policy'), 'no-referrer');
  assert.equal(header('X-Frame-Options'), 'DENY');
  assert.ok(header('Permissions-Policy')?.includes('camera=()'));
});

test('Vercel builds the app the way the repository does', () => {
  assert.equal(vercel.framework, 'vite');
  assert.equal(vercel.buildCommand, 'npm run build');
  assert.equal(vercel.outputDirectory, 'dist');
});
