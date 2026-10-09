import { test } from 'node:test';
import assert from 'node:assert/strict';
import { downgradeCheck, parseStatusLine, parseWindows, shouldRecord, HEADROOM, type LimitSample } from '../src/limits.ts';

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

test('the 5-minute gap is exact: 4:59 is skipped, 5:00 is saved', () => {
  const base: LimitSample = { ts: 1_000_000, five_hour: 10 };
  assert.equal(shouldRecord(base, { ts: base.ts + 5 * 60_000 - 1, five_hour: 10 }), false);
  assert.equal(shouldRecord(base, { ts: base.ts + 5 * 60_000, five_hour: 10 }), true);
});

test('a move of 2 points saves a sample, 1.9 does not, and the direction does not matter', () => {
  const base: LimitSample = { ts: 1_000_000, five_hour: 50 };
  const soon = base.ts + 1000;
  assert.equal(shouldRecord(base, { ts: soon, five_hour: 51.9 }), false);
  assert.equal(shouldRecord(base, { ts: soon, five_hour: 52 }), true);
  assert.equal(shouldRecord(base, { ts: soon, five_hour: 48 }), true, 'a drop (the window reset) counts too');
  assert.equal(shouldRecord(base, { ts: soon, five_hour: 48.1 }), false);
});

test('each limit window is read on its own, so one can be missing', () => {
  assert.deepEqual(parseWindows({ rate_limits: { five_hour: { used_percentage: 12 } } }), { five: 12, seven: undefined });
  assert.deepEqual(parseWindows({ rate_limits: { seven_day: { used_percentage: 41 } } }), { five: undefined, seven: 41 });
  assert.deepEqual(parseWindows({ rate_limits: { five_hour: { used_percentage: 101 }, seven_day: { used_percentage: -1 } } }), { five: undefined, seven: undefined });
  assert.deepEqual(parseWindows(null), { five: undefined, seven: undefined });
  assert.deepEqual(parseWindows({ rate_limits: { five_hour: { used_percentage: 0 }, seven_day: { used_percentage: 100 } } }), { five: 0, seven: 100 });
});

test('a lower plan fits at exactly 80% of its window and not above', () => {
  // Max 20x at 16% = 3.2 Pro windows. Max 5x would need 64%. Pro would need 320%.
  const rows = downgradeCheck(16, 20, [{ plan: 'Max 5x', multiplier: 5 }, { plan: 'Pro', multiplier: 1 }]);
  assert.equal(rows[0].fits, true);
  assert.equal(rows[1].fits, false);
  // 20% of Max 20x is 4 Pro windows, which is exactly 80% of Max 5x's window: still fits
  const edge = downgradeCheck(20, 20, [{ plan: 'Max 5x', multiplier: 5 }]);
  assert.ok(Math.abs(edge[0].neededPercent - 80) < 1e-9);
  assert.equal(edge[0].fits, true);
  assert.equal(downgradeCheck(20.1, 20, [{ plan: 'Max 5x', multiplier: 5 }])[0].fits, false);
});
