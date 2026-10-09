import { UsageReport } from '../types';
import { PLANS, PlanKey } from './pricing';

export const MAX_FILE_BYTES = 50 * 1024 * 1024;

/** The model label used for claude.ai exports, which have no model names or token counts. */
export const ESTIMATED_MODEL = 'Claude (estimated)';

const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/;

/** Local calendar day as YYYY-MM-DD, the same meaning the CLI uses. */
const localDay = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
/** A real number of 0 or more. Text, NaN, Infinity and negatives are not. */
const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;
const isOptionalCount = (v: unknown): boolean => v === undefined || isCount(v);

/**
 * Checks everything the dashboard, the exports and the saved list read, so a wrong or damaged file
 * is turned away here and not while a screen is drawing.
 */
export function isUsageReport(json: unknown): json is UsageReport {
  if (!isObject(json) || typeof json.provider !== 'string') return false;

  const { period, plan, usage } = json;
  if (!isObject(period) || typeof period.start !== 'string' || typeof period.end !== 'string') return false;
  if (Number.isNaN(Date.parse(period.start)) || Number.isNaN(Date.parse(period.end))) return false;
  if (!isObject(plan) || typeof plan.name !== 'string' || !isCount(plan.price_usd)) return false;
  if (!isObject(usage) || !isObject(usage.tokens) || !isObject(usage.messages) || !isObject(usage.sessions)) return false;

  const { tokens, messages, sessions } = usage;
  if (!isCount(tokens.input) || !isCount(tokens.output) || !isOptionalCount(tokens.cached)) return false;
  if (!isObject(tokens.by_model)) return false;
  for (const m of Object.values(tokens.by_model)) {
    if (!isObject(m) || !isCount(m.input) || !isCount(m.output)) return false;
    if (!isOptionalCount(m.cache_read) || !isOptionalCount(m.cache_write) || !isOptionalCount(m.cache_write_1h)) return false;
  }

  if (!isCount(messages.count) || !isOptionalCount(messages.unfinished) || !Array.isArray(messages.by_day)) return false;
  for (const d of messages.by_day) {
    if (!isObject(d) || typeof d.date !== 'string' || !DAY_KEY.test(d.date)) return false;
    if (!isCount(d.count) || !isCount(d.input) || !isCount(d.output)) return false;
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
export function convertClaudeExport(data: unknown[], plan: PlanKey): UsageReport {
  const usage: UsageReport = {
    provider: 'anthropic',
    source: 'manual_upload',
    period: { start: new Date().toISOString(), end: new Date().toISOString() },
    plan: { name: plan, price_usd: PLANS[plan].price, type: 'subscription' },
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

export type ImportResult = { ok: true; report: UsageReport } | { ok: false; error: string };

/** Turn the text of a dropped file into a report, or say plainly what is wrong with it. */
export function parseUsageFile(text: string, size: number, plan: PlanKey): ImportResult {
  if (size > MAX_FILE_BYTES) {
    return { ok: false, error: 'That file is over 50 MB. Export a shorter date range, or use the command line.' };
  }
  // A ZIP starts with "PK". Exports arrive zipped, so this is a common slip.
  if (text.startsWith('PK\u0003\u0004')) {
    return { ok: false, error: "That's a ZIP file. Unzip it first, then choose conversations.json." };
  }

  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { ok: false, error: "We can't read that file. Choose conversations.json or usage_report.json." };
  }

  if (isUsageReport(json)) return { ok: true, report: json };

  if (Array.isArray(json) && json.some((c) => isObject(c) && (c.uuid || c.chat_messages))) {
    const report = convertClaudeExport(json, plan);
    if (report.usage.messages.count === 0) {
      return { ok: false, error: 'No chats in that file. Look for conversations.json in the unzipped folder.' };
    }
    return { ok: true, report };
  }

  return { ok: false, error: "That file isn't a usage report or a claude.ai export. Choose conversations.json or usage_report.json." };
}
