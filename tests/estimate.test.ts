import { test } from 'node:test';
import assert from 'node:assert/strict';
import { estimateQuality, decide, tieBand, MINIMUM_SHARE, type EstimateInput } from '../services/estimate.ts';

const input = (opts: { replies: number; unfinished?: number; priced?: number; unpriced?: number }): EstimateInput => ({
  usage: {
    tokens: {
      by_model: {
        'claude-sonnet-5-5': { input: opts.priced ?? 1_000_000, output: 0 },
        ...(opts.unpriced ? { 'claude-mystery-9': { input: opts.unpriced, output: 0 } } : {}),
      },
    },
    messages: { count: opts.replies, unfinished: opts.unfinished },
  },
});

test('a report with every reply finished and every model priced is an estimate, not a minimum', () => {
  const q = estimateQuality(input({ replies: 100, unfinished: 0 }));
  assert.equal(q.lowerBound, false);
  assert.equal(q.unfinishedShare, 0);
  assert.equal(q.unpricedShare, 0);
});

test('a report from an older scan with no unfinished count is treated as having none', () => {
  assert.equal(estimateQuality(input({ replies: 100 })).lowerBound, false);
});

test('more than 5% unfinished replies makes the cost a minimum; exactly 5% does not', () => {
  assert.equal(MINIMUM_SHARE, 0.05);
  assert.equal(estimateQuality(input({ replies: 100, unfinished: 5 })).lowerBound, false);
  assert.equal(estimateQuality(input({ replies: 100, unfinished: 6 })).lowerBound, true);
});

test('more than 5% of tokens from unpriced models makes the cost a minimum', () => {
  assert.equal(estimateQuality(input({ replies: 10, priced: 950_000, unpriced: 50_000 })).lowerBound, false);
  assert.equal(estimateQuality(input({ replies: 10, priced: 940_000, unpriced: 60_000 })).lowerBound, true);
});

test('the unfinished count can never exceed the replies', () => {
  const q = estimateQuality(input({ replies: 10, unfinished: 500 }));
  assert.equal(q.unfinishedReplies, 10);
  assert.equal(q.unfinishedShare, 1);
});

test('with an exact estimate: plan cheaper is keep, pay-as-you-go cheaper is switch, within the band is tie', () => {
  assert.equal(decide(20, 50, false), 'keep');
  assert.equal(decide(20, 5, false), 'switch');
  assert.equal(decide(20, 20.4, false), 'tie');
  assert.equal(decide(20, 19.2, false), 'tie');
  assert.equal(decide(200, 195, false), 'tie');   // 5% of $200 is $10
  assert.equal(decide(200, 185, false), 'switch');
});

test('the tie band is a dollar, or 5% of the plan price when that is more', () => {
  assert.equal(tieBand(20), 1);
  assert.equal(tieBand(100), 5);
  assert.equal(tieBand(200), 10);
});

test('a minimum can show the plan is the better deal, but can never show that pay-as-you-go is', () => {
  assert.equal(decide(20, 50, true), 'keep');
  assert.equal(decide(20, 20, true), 'keep');
  assert.equal(decide(20, 19.99, true), 'unknown');
  assert.equal(decide(200, 5, true), 'unknown');
});
