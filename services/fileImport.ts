import { UsageReport } from '../types';
import { looksLikeCursorCsv, parseCursorCsv } from './cursorImport';
import { PRODUCT_IDS } from './products';

/**
 * The biggest file this page opens. A file is read as text and parsed, which takes about twice its size in memory
 * (measured: a 200 MB chat export parses in under a second and peaks near 500 MB). Past this size a tab could run out of memory.
 */
export const MAX_FILE_BYTES = 200 * 1024 * 1024;
const MAX_MB = MAX_FILE_BYTES / (1024 * 1024);

/** A ZIP file starts with these four characters. Exports arrive zipped, so choosing the ZIP itself is a common slip. */
export const ZIP_SIGNATURE = 'PK\u0003\u0004';

export const ZIP_MESSAGE = "That's a ZIP file. Unzip it first, then choose conversations.json.";
export const TOO_BIG_MESSAGE =
  `That file is over ${MAX_MB} MB, which is more than this page can open. If you use Claude Code, \`npx llm-usage-analyzer\` reads your history without a file.`;

/** The model label used for claude.ai exports, which have no model names or token counts. */
export const ESTIMATED_MODEL = 'Claude (estimated)';

const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/;
const PROVIDERS: string[] = ['anthropic', 'openai', 'google', 'xai', 'other'];
const PRODUCTS: string[] = PRODUCT_IDS;
/** A tool name is a short label. A long one is a damaged or invented file. */
const MAX_TOOL_CHARS = 60;
const SOURCES: string[] = ['local_agent', 'browser_extension', 'api', 'manual_upload', 'demo', 'manual_entry'];
const PLAN_TYPES: string[] = ['subscription', 'payg'];

/** Local calendar day as YYYY-MM-DD, the same meaning the CLI uses. */
const localDay = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
/** The largest count that is believable (a quadrillion). Anything above is a damaged or invented file. */
const MAX_COUNT = 1e15;
/** A real number from 0 to a quadrillion. Text, NaN, Infinity, negatives and absurd sizes are not. */
const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= MAX_COUNT;
const isOptionalCount = (v: unknown): boolean => v === undefined || isCount(v);

/**
 * Checks everything the dashboard, the exports and the saved list read, so a wrong or damaged file
 * is turned away here and not while a screen is drawing.
 */
export function isUsageReport(json: unknown): json is UsageReport {
  if (!isObject(json) || typeof json.provider !== 'string' || !PROVIDERS.includes(json.provider)) return false;
  if (typeof json.source !== 'string' || !SOURCES.includes(json.source)) return false;
  if (json.product !== undefined && (typeof json.product !== 'string' || !PRODUCTS.includes(json.product))) return false;
  if (json.tool !== undefined && (typeof json.tool !== 'string' || !json.tool || json.tool.length > MAX_TOOL_CHARS)) return false;

  const { period, plan, usage } = json;
  if (!isObject(period) || typeof period.start !== 'string' || typeof period.end !== 'string') return false;
  const start = Date.parse(period.start);
  const end = Date.parse(period.end);
  // A period that runs backwards would be read as one day, and the monthly cost multiplied by 30
  if (Number.isNaN(start) || Number.isNaN(end) || start > end) return false;
  if (!isObject(plan) || typeof plan.name !== 'string' || !isCount(plan.price_usd) || !PLAN_TYPES.includes(plan.type as string)) return false;
  if (!isObject(usage) || !isObject(usage.tokens) || !isObject(usage.messages) || !isObject(usage.sessions)) return false;

  if (usage.incomplete !== undefined && typeof usage.incomplete !== 'boolean') return false;
  if (usage.on_demand !== undefined) {
    const d = usage.on_demand;
    if (!isObject(d) || !isCount(d.usd) || !isCount(d.rows) || !isCount(d.rows_without_cost)) return false;
  }
  const { tokens, messages, sessions } = usage;
  if (!isCount(tokens.input) || !isCount(tokens.output) || !isOptionalCount(tokens.cached)) return false;
  if (!isObject(tokens.by_model)) return false;
  for (const m of Object.values(tokens.by_model)) {
    if (!isObject(m) || !isCount(m.input) || !isCount(m.output)) return false;
    if (!isOptionalCount(m.cache_read) || !isOptionalCount(m.cache_write) || !isOptionalCount(m.cache_write_1h)) return false;
  }

  if (!isCount(messages.count) || !isOptionalCount(messages.unfinished) || !Array.isArray(messages.by_day)) return false;
  let previousDay = '';
  for (const d of messages.by_day) {
    if (!isObject(d) || typeof d.date !== 'string' || !DAY_KEY.test(d.date)) return false;
    if (!isCount(d.count) || !isCount(d.input) || !isCount(d.output)) return false;
    // Days in order, each once: the charts and the Trends rely on it
    if (d.date <= previousDay) return false;
    previousDay = d.date;
  }
  return isCount(sessions.count);
}

/** A time stamp from an export, or null when it is missing or not a date. */
function validDate(value: unknown): Date | null {
  if (typeof value !== 'string') return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** The text of one chat message. Exports have `text`, or a list of content blocks that each have `text`. */
function messageText(msg: Record<string, unknown>): string {
  if (typeof msg.text === 'string' && msg.text) return msg.text;
  if (Array.isArray(msg.content)) {
    return msg.content
      .map((block) => (isObject(block) && typeof block.text === 'string' ? block.text : ''))
      .join('\n');
  }
  return '';
}

const estimateTokens = (text: string) => Math.ceil(text.length / 4);

/**
 * A claude.ai conversations.json export. Anthropic documents no format for it, so this reads what is
 * there and skips what is not. It has no model names or token counts, so tokens are estimated from
 * text length (4 characters each) and a cost cannot be worked out.
 * A reply is one assistant message, the same meaning the CLI uses.
 */
export function convertClaudeExport(data: unknown[]): UsageReport {
  const usage: UsageReport = {
    provider: 'anthropic',
    product: 'claude',
    tool: 'claude.ai',
    source: 'manual_upload',
    period: { start: new Date().toISOString(), end: new Date().toISOString() },
    // A chat export says nothing about the plan, so none is claimed. The plan is chosen on the screen.
    plan: { name: 'Not set', price_usd: 0, type: 'subscription' },
    usage: {
      tokens: { input: 0, output: 0, cached: 0, by_model: {} },
      messages: { count: 0, by_day: [] },
      sessions: { count: 0 },
    },
  };

  let minDate: Date | null = null;
  let maxDate: Date | null = null;
  const dayMap = new Map<string, { count: number; input: number; output: number }>();

  for (const conversation of data) {
    if (!isObject(conversation)) continue;
    usage.usage.sessions.count++;
    const started = validDate(conversation.created_at);
    const messages = Array.isArray(conversation.chat_messages) ? conversation.chat_messages : [];

    for (const msg of messages) {
      if (!isObject(msg)) continue;
      const isReply = msg.sender === 'assistant';
      if (!isReply && msg.sender !== 'human' && msg.sender !== 'user') continue;

      const tokens = estimateTokens(messageText(msg));
      if (isReply) {
        usage.usage.tokens.output += tokens;
        usage.usage.messages.count++;
      } else {
        usage.usage.tokens.input += tokens;
      }

      // Each message goes on its own day when the export says when it was written
      const when = validDate(msg.created_at) ?? started;
      if (!when) continue;
      if (!minDate || when < minDate) minDate = when;
      if (!maxDate || when > maxDate) maxDate = when;
      const key = localDay(when);
      const day = dayMap.get(key) ?? { count: 0, input: 0, output: 0 };
      if (isReply) { day.count++; day.output += tokens; } else { day.input += tokens; }
      dayMap.set(key, day);
    }
  }

  if (minDate && maxDate) {
    usage.period.start = minDate.toISOString();
    usage.period.end = maxDate.toISOString();
  }
  usage.usage.messages.by_day = [...dayMap.entries()]
    .map(([date, stats]) => ({ date, ...stats }))
    .sort((a, b) => a.date.localeCompare(b.date));

  usage.usage.tokens.by_model[ESTIMATED_MODEL] = {
    input: usage.usage.tokens.input,
    output: usage.usage.tokens.output,
  };

  return usage;
}

/** The format name in a file that holds several reports (one per tool), as written by `llm-usage-analyzer scan`. */
export const BUNDLE_FORMAT = 'llm-usage-bundle';
/** More reports than this in one file is not a real scan (there is one per tool). */
const MAX_BUNDLE_REPORTS = 20;

export interface UsageBundle {
  format: typeof BUNDLE_FORMAT;
  version: 1;
  reports: UsageReport[];
}

/** A file or answer with several reports. Each one is checked like a single report, and there must be at least one. */
export function isUsageBundle(json: unknown): json is UsageBundle {
  return isObject(json) && json.format === BUNDLE_FORMAT && json.version === 1 &&
    Array.isArray(json.reports) && json.reports.length > 0 && json.reports.length <= MAX_BUNDLE_REPORTS &&
    json.reports.every(isUsageReport);
}

/** The reports in a parsed file or server answer: one report, or the reports of a bundle. Null when it is neither. */
export function reportsIn(json: unknown): UsageReport[] | null {
  if (isUsageReport(json)) return [json];
  if (isUsageBundle(json)) return json.reports;
  return null;
}

export type ImportResult = { ok: true; reports: UsageReport[] } | { ok: false; error: string };

/** Turn the text of a dropped file into a report, or say plainly what is wrong with it. */
export function parseUsageFile(text: string, size: number): ImportResult {
  // A ZIP is named as one, whatever its size: a big export ZIP should get the "unzip it" hint, not "too big"
  if (text.startsWith(ZIP_SIGNATURE)) return { ok: false, error: ZIP_MESSAGE };
  if (size > MAX_FILE_BYTES) return { ok: false, error: TOO_BIG_MESSAGE };

  // A Cursor usage export is a CSV, not JSON
  if (looksLikeCursorCsv(text)) {
    const cursor = parseCursorCsv(text);
    if (cursor.ok === false) return { ok: false, error: cursor.error };
    // The same check as any other file, so a strange export cannot reach the screens
    return isUsageReport(cursor.report)
      ? { ok: true, reports: [cursor.report] }
      : { ok: false, error: "We couldn't read that Cursor export. Export it again from Cursor's Usage page." };
  }

  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { ok: false, error: "We can't read that file. Choose conversations.json, a Cursor usage CSV, or usage_report.json." };
  }

  const reports = reportsIn(json);
  if (reports) return { ok: true, reports };

  if (Array.isArray(json) && json.some((c) => isObject(c) && (c.uuid || c.chat_messages))) {
    const report = convertClaudeExport(json);
    if (report.usage.messages.count === 0) {
      return { ok: false, error: 'No chats in that file. Look for conversations.json in the unzipped folder.' };
    }
    return { ok: true, reports: [report] };
  }

  return { ok: false, error: "That file isn't a usage report, a claude.ai export or a Cursor usage CSV. Choose conversations.json, a Cursor CSV, or usage_report.json." };
}
