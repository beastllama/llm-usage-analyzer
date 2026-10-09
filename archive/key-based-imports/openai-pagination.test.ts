import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { fetchOpenAIUsage } from '../services/openaiService.ts';

// Responses shaped like OpenAI's Usage API: each daily bucket holds a `results` array.
const bucket = (day: number, results: unknown[]) => ({
  object: 'bucket',
  start_time: Date.UTC(2026, 9, day) / 1000,
  end_time: Date.UTC(2026, 9, day + 1) / 1000,
  results,
});

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

function mockPages(pages: unknown[]) {
  const calls: string[] = [];
  globalThis.fetch = (async (url: string | URL | Request) => {
    calls.push(String(url));
    return new Response(JSON.stringify(pages[calls.length - 1]), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return calls;
}

test('follows the cursor across pages and adds up every bucket', async () => {
  const calls = mockPages([
    { object: 'page', data: [bucket(1, [{ model: 'gpt-4o', input_tokens: 1000, input_cached_tokens: 200, output_tokens: 100, num_model_requests: 3 }])], has_more: true, next_page: 'page_2' },
    { object: 'page', data: [bucket(2, [{ model: 'gpt-4o', input_tokens: 500, output_tokens: 50, num_model_requests: 2 }])], has_more: false, next_page: null },
  ]);
  const report = await fetchOpenAIUsage('sk-admin-test', new Date(Date.UTC(2026, 9, 1)), new Date(Date.UTC(2026, 9, 3)));

  assert.equal(calls.length, 2);
  assert.ok(!new URL(calls[0]).searchParams.has('page'));
  assert.equal(new URL(calls[1]).searchParams.get('page'), 'page_2');
  assert.equal(report.usage.messages.count, 5);
  assert.equal(report.usage.tokens.input, 800 + 500, 'cached input is split out, then counted once');
  assert.equal(report.usage.tokens.cached, 200);
  assert.equal(report.usage.tokens.output, 150);
  assert.equal(report.usage.messages.by_day.length, 2);
});

test('a report with more pages but no cursor is refused, not returned short', async () => {
  mockPages([{ object: 'page', data: [bucket(1, [])], has_more: true, next_page: null }]);
  await assert.rejects(
    fetchOpenAIUsage('sk-admin-test', new Date(Date.UTC(2026, 9, 1)), new Date(Date.UTC(2026, 9, 3))),
    /no way to reach them/,
  );
});
