import { test } from 'node:test';
import assert from 'node:assert/strict';
import { downgradeCheck, parseStatusLine, shouldRecord, HEADROOM, type LimitSample } from '../src/limits.ts';

const LOWER = [
  { plan: 'Claude Max 5x', multiplier: 5 },
  { plan: 'Claude Pro', multiplier: 1 },
];

test('downgrade check scales the peak by published plan multipliers', () => {
  // 10% of a Max 20x window = 2 Pro windows = 40% of Max 5x and 200% of Pro
  const rows = downgradeCheck(10, 20, LOWER);
  assert.equal(Math.round(rows[0].neededPercent), 40);
  assert.equal(rows[0].fits, true);
  assert.equal(Math.round(rows[1].neededPercent), 200);
  assert.equal(rows[1].fits, false);
});

test('a peak of 62% on Max 20x does not fit Max 5x', () => {
  const rows = downgradeCheck(62, 20, LOWER);
  assert.equal(Math.round(rows[0].neededPercent), 248);
  assert.equal(rows[0].fits, false);
});

test('the fit rule keeps headroom below 80% of the lower window', () => {
  assert.equal(HEADROOM, 0.8);
  // Needs exactly 80% of Max 5x: still fits. Just over: does not.
  assert.equal(downgradeCheck(20, 20, [{ plan: 'x', multiplier: 5 }])[0].fits, true);
  assert.equal(downgradeCheck(20.5, 20, [{ plan: 'x', multiplier: 5 }])[0].fits, false);
});

test('status-line parsing accepts only valid percentages', () => {
  const ok = parseStatusLine({ rate_limits: { five_hour: { used_percentage: 42 } } });
  assert.equal(ok?.five_hour, 42);
  assert.equal(parseStatusLine({}), null);
  assert.equal(parseStatusLine({ rate_limits: { five_hour: { used_percentage: 150 } } }), null);
  assert.equal(parseStatusLine({ rate_limits: { five_hour: { used_percentage: 'high' } } }), null);
  assert.equal(parseStatusLine(null), null);
});

test('samples are throttled: one per 5 minutes unless the value moves 2+ points', () => {
  const base: LimitSample = { ts: 1_000_000, five_hour: 10 };
  assert.equal(shouldRecord(null, base), true);
  assert.equal(shouldRecord(base, { ts: base.ts + 60_000, five_hour: 10 }), false);
  assert.equal(shouldRecord(base, { ts: base.ts + 60_000, five_hour: 12.5 }), true);
  assert.equal(shouldRecord(base, { ts: base.ts + 6 * 60_000, five_hour: 10 }), true);
});
