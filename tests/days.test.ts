import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withQuietDays, MAX_FILLED_DAYS } from '../services/dailyRows.ts';
import { MOCK_DATA } from '../constants.ts';

const row = (date: string, count = 1) => ({ date, count, input: count * 10, output: count });

test('quiet days are filled in as zero between the first and the last day', () => {
  const rows = withQuietDays([row('2026-10-01'), row('2026-10-04', 3)]);
  assert.deepEqual(rows.map((r) => r.date), ['2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04']);
  assert.deepEqual(rows.map((r) => r.count), [1, 0, 0, 3]);
  assert.deepEqual(rows[1], { date: '2026-10-02', count: 0, input: 0, output: 0 });
});

test('fewer than two rows are returned as they are', () => {
  assert.deepEqual(withQuietDays([]), []);
  const one = [row('2026-10-01')];
  assert.equal(withQuietDays(one), one);
});

test('rows given out of order are drawn in order', () => {
  const rows = withQuietDays([row('2026-10-03'), row('2026-10-01')]);
  assert.deepEqual(rows.map((r) => r.date), ['2026-10-01', '2026-10-02', '2026-10-03']);
});

test('the demo has one bar for each of its 15 days, in every zone, including those that change the clock at midnight', () => {
  const before = process.env.TZ;
  try {
    for (const tz of ['UTC', 'America/Los_Angeles', 'Pacific/Kiritimati', 'America/Santiago', 'Asia/Beirut', 'America/Havana', 'Atlantic/Azores', 'Africa/Cairo']) {
      process.env.TZ = tz;
      assert.equal(withQuietDays(MOCK_DATA.usage.messages.by_day).length, 15, tz);
    }
  } finally {
    if (before === undefined) delete process.env.TZ; else process.env.TZ = before;
  }
});

test('a range longer than about three years is not filled, so the chart stays drawable', () => {
  const rows = [row('2020-01-01'), row('2026-10-01')];
  assert.equal(withQuietDays(rows).length, 2);
  assert.ok(MAX_FILLED_DAYS >= 1000);
});
