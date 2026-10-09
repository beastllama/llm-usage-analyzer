import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// The CLI keeps its own copy of the price table so it can ship on its own.
// This test fails if the two copies drift apart.
const body = (file: string, end?: string) => {
  const text = readFileSync(file, 'utf8');
  const start = text.indexOf('export interface ModelPrice');
  const stop = end ? text.indexOf(end, start) : text.length;
  return text.slice(start, stop).trimEnd();
};

test('the CLI price table is identical to the web app price table', () => {
  const web = body('services/pricing.ts');
  const cli = body('packages/cli/src/pricing.ts', '// Short names for the command line');
  assert.equal(cli, web, 'run "npm run sync:pricing": packages/cli/src/pricing.ts must match services/pricing.ts');
});
