import { test } from 'node:test';
import assert from 'node:assert/strict';
import { plain, formatCount, formatUsd, formatApproxUsd, formatTokenNumber, parseDay, formatDay, formatDate } from '../services/format.ts';

test('dollars have thousands separators and two decimals', () => {
  assert.equal(formatUsd(0), '$0.00');
  assert.equal(formatUsd(19480), '$19,480.00');
  assert.equal(formatUsd(1234567.891), '$1,234,567.89');
  assert.equal(formatUsd(NaN), '$0.00');
  assert.equal(formatUsd(Infinity), '$0.00');
});

test('"about" dollars are rounded so an estimate does not look exact', () => {
  assert.equal(formatApproxUsd(0), '$0.00');
  assert.equal(formatApproxUsd(4.256), '$4.26');
  assert.equal(formatApproxUsd(9.999), '$10.00');
  assert.equal(formatApproxUsd(10), '$10');
  assert.equal(formatApproxUsd(54.6), '$55');
  assert.equal(formatApproxUsd(99.4), '$99');
  assert.equal(formatApproxUsd(100), '$100');
  assert.equal(formatApproxUsd(1234), '$1,230');
  assert.equal(formatApproxUsd(19484), '$19,480');
  assert.equal(formatApproxUsd(-5), '$0.00');
  assert.equal(formatApproxUsd(NaN), '$0.00');
});

test('token counts are short, and round before choosing the unit', () => {
  assert.equal(formatTokenNumber(0), '0');
  assert.equal(formatTokenNumber(950), '950');
  assert.equal(formatTokenNumber(999), '999');
  assert.equal(formatTokenNumber(1000), '1.0k');
  assert.equal(formatTokenNumber(1234), '1.2k');
  assert.equal(formatTokenNumber(999_949), '999.9k');
  assert.equal(formatTokenNumber(999_950), '1.0M', 'not 1000.0k');
  assert.equal(formatTokenNumber(3_400_000), '3.4M');
  assert.equal(formatTokenNumber(999_949_999), '999.9M');
  assert.equal(formatTokenNumber(999_950_000), '1.0B', 'not 1000.0M');
  assert.equal(formatTokenNumber(1_100_000_000), '1.1B');
  assert.equal(formatTokenNumber(NaN), '0');
});

test('whole numbers have thousands separators', () => {
  assert.equal(formatCount(6360), '6,360');
  assert.equal(formatCount(12.6), '13');
  assert.equal(formatCount(NaN), '0');
});

test('control characters are removed from text that came from a file', () => {
  assert.equal(plain('claude\u001b[31m-opus\u0007'), 'claude[31m-opus');
  assert.equal(plain('line one\nline two\r\n'), 'line oneline two');
  assert.equal(plain('tab\there'), 'tabhere');
  assert.equal(plain('\u0085next\u009f'), 'next');
  assert.equal(plain(42), '42');
  assert.equal(plain('plain text, with punctuation: ok'), 'plain text, with punctuation: ok');
});

test('a day key is a calendar date on the viewer\'s clock', () => {
  const d = parseDay('2026-09-30');
  assert.deepEqual([d.getFullYear(), d.getMonth(), d.getDate()], [2026, 8, 30]);
  assert.equal(formatDay('2026-09-30'), 'Sep 30');
  assert.equal(formatDay('2026-01-05'), 'Jan 5');
});

test('a date from a report is written out, and text that is not a date is kept as plain text', () => {
  assert.equal(formatDate(new Date(2026, 8, 30, 12).toISOString()), 'Sep 30, 2026');
  assert.equal(formatDate('not a date'), 'not a date');
  assert.equal(formatDate('bad\u001b[0m'), 'bad[0m');
});
