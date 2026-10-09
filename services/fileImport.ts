import { UsageReport } from '../types';
import { PLANS, PlanKey } from './pricing';

export const MAX_FILE_BYTES = 50 * 1024 * 1024;

const estimateTokens = (text: string) => Math.ceil(text.length / 4);

/** Local calendar day as YYYY-MM-DD, the same meaning the CLI uses. */
const localDay = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/**
 * Checks the fields the dashboard and exports read, so a wrong file fails here and not while rendering.
 * Every number must really be a number.
 */
export function isUsageReport(json: any): json is UsageReport {
  return Boolean(
    json &&
    typeof json === 'object' &&
    json.usage &&
    json.usage.tokens &&
    typeof json.usage.tokens.input === 'number' &&
    typeof json.usage.tokens.output === 'number' &&
    json.usage.tokens.by_model &&
    typeof json.usage.tokens.by_model === 'object' &&
    json.usage.messages &&
    Array.isArray(json.usage.messages.by_day) &&
    json.period &&
    typeof json.period.start === 'string' &&
    typeof json.period.end === 'string' &&
    json.plan &&
    typeof json.plan.price_usd === 'number' &&
    Object.values(json.usage.tokens.by_model).every((m: any) =>
      m && Number.isFinite(m.input) && Number.isFinite(m.output) &&
      (m.cache_read === undefined || Number.isFinite(m.cache_read)) &&
      (m.cache_write === undefined || Number.isFinite(m.cache_write)) &&
      (m.cache_write_1h === undefined || Number.isFinite(m.cache_write_1h))
    ) &&
    json.usage.messages.by_day.every((d: any) =>
      d && typeof d.date === 'string' && Number.isFinite(d.count) && Number.isFinite(d.input) && Number.isFinite(d.output)
    ) &&
    Number.isFinite(json.usage.messages.count)
  );
}

/**
 * A claude.ai conversations.json export. It has no model names or token counts,
 * so tokens are estimated from text length and cost cannot be worked out.
 * A reply is one assistant message, the same meaning the CLI uses.
 */
export function convertClaudeExport(data: any[], plan: PlanKey): UsageReport {
  const usage: UsageReport = {
    provider: 'anthropic',
    source: 'manual_upload',
    period: { start: new Date().toISOString(), end: new Date().toISOString() },
    plan: { name: plan, price_usd: PLANS[plan].price, type: 'subscription' },
    usage: {
      tokens: { input: 0, output: 0, cached: 0, by_model: {} },
      messages: { count: 0, by_day: [] },
      sessions: { count: data.length },
    },
  };

  let minDate = new Date();
  let maxDate = new Date(0);
  const dayMap: Record<string, { count: number; input: number; output: number }> = {};

  data.forEach((conversation: any) => {
    const created = new Date(conversation.created_at || Date.now());
    if (created < minDate) minDate = created;
    if (created > maxDate) maxDate = created;

    const dateKey = localDay(created);
    if (!dayMap[dateKey]) dayMap[dateKey] = { count: 0, input: 0, output: 0 };

    (conversation.chat_messages || []).forEach((msg: any) => {
      const tokens = estimateTokens(msg.text || '');
      if (msg.sender === 'human') {
        usage.usage.tokens.input += tokens;
        dayMap[dateKey].input += tokens;
      } else {
        usage.usage.tokens.output += tokens;
        dayMap[dateKey].output += tokens;
        dayMap[dateKey].count++;
        usage.usage.messages.count++;
      }
    });
  });

  usage.period.start = minDate.toISOString();
  usage.period.end = maxDate.toISOString();
  usage.usage.messages.by_day = Object.entries(dayMap)
    .map(([date, stats]) => ({ date, ...stats }))
    .sort((a, b) => a.date.localeCompare(b.date));

  usage.usage.tokens.by_model[ESTIMATED_MODEL] = {
    input: usage.usage.tokens.input,
    output: usage.usage.tokens.output,
  };

  return usage;
}

/** The model label used for claude.ai exports, which do not say which model answered. */
export const ESTIMATED_MODEL = 'Claude (estimated)';

export type ImportResult = { ok: true; report: UsageReport } | { ok: false; error: string };

/** Turn the text of a dropped file into a report, or say plainly what is wrong with it. */
export function parseUsageFile(text: string, size: number, plan: PlanKey): ImportResult {
  if (size > MAX_FILE_BYTES) {
    return { ok: false, error: 'That file is over 50 MB. Export a shorter date range, or use the command line.' };
  }

  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    return { ok: false, error: "That file isn't valid JSON. Use usage_report.json, or conversations.json from Claude.ai." };
  }

  if (isUsageReport(json)) return { ok: true, report: json };

  if (Array.isArray(json) && json.length > 0 && (json[0].uuid || json[0].chat_messages)) {
    const report = convertClaudeExport(json, plan);
    if (report.usage.messages.count === 0) {
      return { ok: false, error: 'This Claude.ai export has no messages in it.' };
    }
    return { ok: true, report };
  }

  return { ok: false, error: "This isn't a usage report or a Claude.ai export. Try usage_report.json, or conversations.json from Claude.ai." };
}
