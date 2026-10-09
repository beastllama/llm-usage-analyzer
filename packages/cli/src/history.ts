import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type { UsageReport, DayUsage } from './types.js';
import type { DayDetail } from './parsers/claude.js';

/**
 * Daily totals kept on this computer. Claude Code deletes transcripts after 30 days by default,
 * so this file is what keeps older days. Stored in ~/.llm-usage (override with LLM_USAGE_HOME).
 */
export function historyDir(): string {
  return process.env.LLM_USAGE_HOME || path.join(os.homedir(), '.llm-usage');
}

export function historyFile(): string {
  return path.join(historyDir(), 'history.json');
}

export function loadHistory(file = historyFile()): Record<string, DayDetail> {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
    return parsed && typeof parsed.days === 'object' && parsed.days !== null ? parsed.days : {};
  } catch {
    return {};
  }
}

/** Write atomically (temp file, then rename), with owner-only permissions. */
export function saveHistory(days: Record<string, DayDetail>, file = historyFile()): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ version: 1, days }, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/**
 * Add stored days that the current scan did not see into the report.
 * Days found in the current scan win, because their transcripts are complete.
 */
export function addHistoryToReport(
  report: UsageReport,
  current: Record<string, DayDetail>,
  stored: Record<string, DayDetail>,
): number {
  let added = 0;
  const tokens = report.usage.tokens;

  for (const [date, d] of Object.entries(stored)) {
    if (current[date]) continue;
    added++;

    tokens.input += d.input;
    tokens.output += d.output;
    for (const [model, m] of Object.entries(d.by_model)) {
      const t = tokens.by_model[model] || { input: 0, output: 0, cache_read: 0, cache_write: 0 };
      t.input += m.input;
      t.output += m.output;
      t.cache_read = (t.cache_read || 0) + m.cache_read;
      t.cache_write = (t.cache_write || 0) + m.cache_write;
      tokens.by_model[model] = t;
      tokens.cached = (tokens.cached || 0) + m.cache_read + m.cache_write;
    }
    report.usage.messages.count += d.count;
    report.usage.messages.by_day.push({ date, count: d.count, input: d.input, output: d.output } as DayUsage);
  }

  report.usage.messages.by_day.sort((a, b) => a.date.localeCompare(b.date));
  if (added > 0 && report.usage.messages.by_day.length > 0) {
    const first = report.usage.messages.by_day[0].date.split('-').map(Number);
    const last = report.usage.messages.by_day[report.usage.messages.by_day.length - 1].date.split('-').map(Number);
    report.period.start = new Date(first[0], first[1] - 1, first[2]).toISOString();
    report.period.end = new Date(last[0], last[1] - 1, last[2], 23, 59, 59).toISOString();
  }
  return added;
}
