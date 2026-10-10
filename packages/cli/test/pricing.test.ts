import { test } from 'node:test';
import assert from 'node:assert/strict';
import { priceFor, tokenCost, costByModel, billingKey, PLANS } from '../src/pricing.ts';

test('dated model IDs match the longest known prefix', () => {
  // "claude-opus-5-5-..." must not be priced as plain "claude-opus-5"
  assert.equal(priceFor('claude-opus-5-5-20260101')?.input, 4);
  assert.equal(priceFor('claude-opus-5-20250101')?.input, 5);
  assert.equal(priceFor('claude-sonnet-5-5')?.output, 10);
});

test('unknown models are reported as unpriced, not guessed', () => {
  assert.equal(priceFor('claude-mystery-9'), null);
  assert.deepEqual(tokenCost('claude-mystery-9', { input: 1_000_000, output: 1_000_000 }), { cost: 0, priced: false });
});

test('cache reads and writes are priced with their own multipliers', () => {
  // Sonnet 5.5: input $2, output $10, cache read 0.05x = $0.10, cache write 1.25x = $2.50 per 1M
  const r = tokenCost('claude-sonnet-5-5', { input: 0, output: 0, cache_read: 1_000_000, cache_write: 1_000_000 });
  assert.equal(r.priced, true);
  assert.ok(Math.abs(r.cost - 2.6) < 1e-9, `expected 2.6, got ${r.cost}`);
});

test('costByModel totals priced models and lists the rest', () => {
  const out = costByModel({
    'claude-opus-5-5': { input: 1_000_000, output: 0 },
    'claude-mystery-9': { input: 5, output: 5 },
  });
  assert.equal(out.cost, 4);
  assert.deepEqual(out.unpricedModels, ['claude-mystery-9']);
});

test('plan multipliers match Anthropic\'s published allowances', () => {
  assert.equal(PLANS['Claude Pro'].multiplier, 1);
  assert.equal(PLANS['Claude Max 5x'].multiplier, 5);
  assert.equal(PLANS['Claude Max 20x'].multiplier, 20);
});

test('a newer model id that is not in the table is unpriced, not priced like an older model', () => {
  assert.equal(priceFor('claude-opus-5-6'), null);
  assert.equal(priceFor('claude-sonnet-5-6'), null);
  assert.equal(priceFor('claude-opus-5-5-20260315')?.input, 4);
  assert.equal(priceFor('gpt-6.2-sol'), null);
  assert.equal(priceFor('gemini-4-pro'), null);
});
test('long prompts and dated price changes are billed under their own keys', () => {
  assert.equal(billingKey('claude-haiku-5-5', 100_001), 'claude-haiku-5-5-long-prompt');
  assert.equal(billingKey('claude-haiku-5-5', 100_000), 'claude-haiku-5-5');
  assert.equal(billingKey('gpt-6.1-sol', 272_001), 'gpt-6.1-sol-long-prompt');
  assert.equal(billingKey('gpt-6.1-sol', 272_000), 'gpt-6.1-sol');
  assert.equal(billingKey('gemini-2.5-pro', 200_001), 'gemini-2.5-pro-long-prompt');
  // Flash has one price for every prompt size
  assert.equal(billingKey('gemini-3.8-flash', 900_000), 'gemini-3.8-flash');
  assert.equal(billingKey('gemini-3.8-flash', 10, new Date(2026, 11, 31, 23, 59)), 'gemini-3.8-flash');
  assert.equal(billingKey('gemini-3.8-flash', 10, new Date(2027, 0, 1, 0, 0)), 'gemini-3.8-flash-from-2027');
  // An unknown model is left as it is, whatever its size
  assert.equal(billingKey('gpt-6.2-sol', 900_000), 'gpt-6.2-sol');
});
test('Haiku 5.5 requests over 100K prompt tokens use the long-prompt rate', () => {
  assert.equal(priceFor('claude-haiku-5-5-long-prompt')?.input, 0.5);
  assert.equal(priceFor('claude-haiku-5-5-long-prompt')?.output, 2.5);
  assert.equal(priceFor('claude-haiku-5-5')?.input, 0.1);
});
