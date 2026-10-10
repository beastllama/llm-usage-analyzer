import { test } from 'node:test';
import assert from 'node:assert/strict';
import { calculateAnalysis } from '../services/analysisService.ts';
import { describeAnswer, describeCaveats } from '../services/answer.ts';
import { report, oneDay } from './helpers.ts';
import type { UsageReport } from '../types.ts';

const answerFor = (r: UsageReport, plan: Parameters<typeof calculateAnalysis>[1] = 'Claude Pro') => describeAnswer(calculateAnalysis(r, plan));

test('when the plan costs less, the answer says so and shows how much', () => {
  const a = answerFor(oneDay({ tokens: 400_000 })); // $24 a month against $20
  assert.equal(a.tone, 'keep');
  assert.equal(a.headline, 'Your Claude Pro plan costs less than pay-as-you-go.');
  assert.match(a.detail, /About \$4\.00 a month less/);
  assert.match(a.detail, /estimate/);
  assert.deepEqual(a.caveats.filter((c) => !c.startsWith('Early guess')), []);
});

test('when pay-as-you-go costs less, the answer says so', () => {
  const a = answerFor(oneDay({ tokens: 200_000, days: 10 })); // $1.20 a month against $20
  assert.equal(a.tone, 'switch');
  assert.equal(a.headline, 'Pay-as-you-go would cost less than your Claude Pro plan.');
});

test('a result within a dollar is called too close', () => {
  const a = answerFor(oneDay({ tokens: 340_000, days: 10 }));
  assert.equal(a.tone, 'switch', '34,000 tokens a day is $2.04 a month here, nowhere near $20');
  const tie = answerFor(oneDay({ tokens: 340_000 })); // $20.40 a month
  assert.equal(tie.tone, 'tie');
  assert.equal(tie.headline, 'Too close to call.');
});

test('a minimum above the plan price is "at least", and a minimum below it is "we cannot say yet"', () => {
  const above = answerFor(oneDay({ tokens: 400_000, replies: 100, unfinished: 40 }));
  assert.equal(above.tone, 'keep');
  assert.match(above.detail, /^At least \$4\.00 a month less\. The real gap is bigger\.$/);
  const below = answerFor(oneDay({ tokens: 200_000, replies: 100, unfinished: 40 }));
  assert.equal(below.tone, 'unknown');
  assert.equal(below.headline, "We can't say yet.");
  assert.match(below.detail, /would cost at least/);
});

test('the caveats explain a short period, cut-short replies and unpriced models in plain words', () => {
  const r = oneDay({ tokens: 400_000, replies: 100, unfinished: 40, days: 3 });
  r.usage.tokens.by_model['claude-mystery-9'] = { input: 400_000, output: 0 };
  const cmp = calculateAnalysis(r, 'Claude Pro');
  const caveats = describeCaveats(cmp);
  assert.deepEqual(caveats, [
    'Early guess: there is under a week of data.',
    '40% of your replies were logged before they finished, so the real cost is higher.',
    'We have no price for mystery-9, so the real cost is higher.',
  ]);
});

test('even a small amount of unpriced usage makes the cost a minimum, and the answer says so', () => {
  const r = oneDay({ tokens: 400_000, days: 10 });
  r.usage.tokens.by_model['claude-mystery-9'] = { input: 1_000, output: 0 };
  const cmp = calculateAnalysis(r, 'Claude Pro');
  assert.equal(cmp.lowerBound, true);
  assert.deepEqual(describeCaveats(cmp), ['We have no price for mystery-9, so the real cost is higher.']);
});

test('model names from a file cannot put control characters into the answer', () => {
  const r = oneDay({ tokens: 400_000, days: 10 });
  r.usage.tokens.by_model['claude-evil\u001b[2J\nmodel'] = { input: 400_000, output: 0 };
  const text = describeCaveats(calculateAnalysis(r, 'Claude Pro')).join(' ');
  assert.ok(!/[\u0000-\u001f]/.test(text));
});

test('a long list of unpriced models is cut to three names', () => {
  const r = report();
  for (const n of ['a', 'b', 'c', 'd', 'e']) r.usage.tokens.by_model[`mystery-${n}`] = { input: 1_000_000, output: 0 };
  assert.match(describeCaveats(calculateAnalysis(r, 'Claude Pro')).join(' '), /mystery-a, mystery-b, mystery-c and 2 more/);
});
