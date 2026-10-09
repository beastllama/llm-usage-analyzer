import { UsageReport } from '../types';

// Shape from OpenAI's Usage API: each daily bucket holds a "results" array, one entry per model.
interface OpenAIUsageResult {
  input_tokens?: number;
  output_tokens?: number;
  input_cached_tokens?: number;
  num_model_requests?: number;
  model?: string | null;
}

interface OpenAIUsageBucket {
  start_time: number; // unix seconds, start of the day (UTC)
  results: OpenAIUsageResult[];
}

interface OpenAIUsageResponse {
  data: OpenAIUsageBucket[];
  has_more: boolean;
  next_page: string | null;
}

const USAGE_URL = 'https://api.openai.com/v1/organization/usage/completions';
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_PAGES = 100;

/**
 * The usage endpoint URL for one page. next_page is an opaque cursor, sent back as `page`
 * with the same query. The admin key only ever goes to this fixed host.
 */
export function usageUrl(startDate: Date, endDate: Date, cursor?: string): string {
  const url = new URL(USAGE_URL);
  url.searchParams.set('start_time', Math.floor(startDate.getTime() / 1000).toString());
  url.searchParams.set('end_time', Math.floor(endDate.getTime() / 1000).toString());
  url.searchParams.set('bucket_width', '1d');
  url.searchParams.set('group_by', 'model');
  if (cursor) url.searchParams.set('page', cursor);
  return url.toString();
}

/**
 * Fetch usage data from OpenAI Usage API
 * Requires an admin API key with usage read permissions
 */
export async function fetchOpenAIUsage(
  apiKey: string,
  startDate: Date,
  endDate: Date
): Promise<UsageReport> {
  const buckets: OpenAIUsageBucket[] = [];
  let cursor: string | undefined;

  for (let page = 0; page < MAX_PAGES; page++) {
    const response = await fetch(usageUrl(startDate, endDate, cursor), {
      headers: { 'Authorization': `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`OpenAI API error (${response.status}): ${error}`);
    }

    const data: OpenAIUsageResponse = await response.json();
    buckets.push(...data.data);

    if (!data.has_more) {
      return transformOpenAIResponse(buckets, startDate, endDate);
    }
    // Never return a short report silently: missing pages would undercount
    if (!data.next_page) {
      throw new Error('OpenAI reported more pages but gave no way to reach them. The report was not loaded.');
    }
    cursor = data.next_page;
  }

  throw new Error(`The date range needs more than ${MAX_PAGES} pages. Use a shorter range.`);
}

/**
 * Transform OpenAI API response to unified UsageReport format
 */
function transformOpenAIResponse(
  buckets: OpenAIUsageBucket[],
  startDate: Date,
  endDate: Date
): UsageReport {
  const report: UsageReport = {
    provider: 'openai',
    source: 'api',
    period: {
      start: startDate.toISOString(),
      end: endDate.toISOString(),
    },
    plan: {
      name: 'OpenAI API',
      price_usd: 0,
      type: 'payg',
    },
    usage: {
      tokens: { input: 0, output: 0, cached: 0, by_model: {} },
      messages: { count: 0, by_day: [] },
      sessions: { count: 0 },
    },
  };

  const dayMap = new Map<string, { count: number; input: number; output: number }>();

  for (const bucket of buckets) {
    const date = new Date(bucket.start_time * 1000).toISOString().split('T')[0];
    const day = dayMap.get(date) || { count: 0, input: 0, output: 0 };

    for (const result of bucket.results || []) {
      const cached = result.input_cached_tokens || 0;
      // OpenAI's input_tokens include cached tokens. Split them so each token is priced once.
      const uncachedInput = Math.max(0, (result.input_tokens || 0) - cached);
      const output = result.output_tokens || 0;
      const requests = result.num_model_requests || 0;
      const model = result.model || 'unknown';

      report.usage.tokens.input += uncachedInput;
      report.usage.tokens.output += output;
      report.usage.tokens.cached = (report.usage.tokens.cached || 0) + cached;
      report.usage.messages.count += requests;

      const modelTotals = report.usage.tokens.by_model[model] || { input: 0, output: 0, cache_read: 0 };
      modelTotals.input += uncachedInput;
      modelTotals.output += output;
      modelTotals.cache_read = (modelTotals.cache_read || 0) + cached;
      report.usage.tokens.by_model[model] = modelTotals;

      day.count += requests;
      day.input += uncachedInput;
      day.output += output;
    }

    dayMap.set(date, day);
  }

  report.usage.messages.by_day = Array.from(dayMap.entries())
    .map(([date, d]) => ({ date, ...d }))
    .sort((a, b) => a.date.localeCompare(b.date));

  return report;
}

/**
 * Validate an OpenAI API key format
 */
export function isValidOpenAIKey(key: string): boolean {
  // OpenAI keys start with 'sk-' and are typically 51+ characters
  return key.startsWith('sk-') && key.length >= 40;
}

/**
 * Test if an API key has usage read permissions
 */
export async function testOpenAIConnection(apiKey: string): Promise<{ success: boolean; error?: string }> {
  try {
    const endDate = new Date();
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - 1);

    const url = new URL(USAGE_URL);
    url.searchParams.set('start_time', Math.floor(startDate.getTime() / 1000).toString());
    url.searchParams.set('end_time', Math.floor(endDate.getTime() / 1000).toString());
    url.searchParams.set('limit', '1');

    const response = await fetch(url.toString(), {
      headers: { 'Authorization': `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (response.ok) {
      return { success: true };
    }

    const errorData = await response.json().catch(() => ({}));
    const errorMessage = errorData.error?.message || `HTTP ${response.status}`;

    if (response.status === 401) {
      return { success: false, error: 'Invalid API key' };
    } else if (response.status === 403) {
      return { success: false, error: 'API key lacks usage read permissions. Admin keys required.' };
    }

    return { success: false, error: errorMessage };
  } catch (err) {
    return { success: false, error: `Connection failed: ${err}` };
  }
}
