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
