import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type { UsageReport, DayUsage } from './types.js';
import type { DayDetail } from './parsers/claude.js';
import { ensurePrivateFolder, writePrivateFile } from './fsafe.js';

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

type Models = DayDetail['by_model'];

const zeroModel = () => ({ input: 0, output: 0, cache_read: 0, cache_write: 0, cache_write_1h: 0 });

const DAY_MS = 24 * 60 * 60 * 1000;
const dayNumber = (key: string): number => {
  const [y, m, d] = key.split('-').map(Number);
  return Date.UTC(y, m - 1, d);
};
const shiftDay = (key: string, delta: number): string => new Date(dayNumber(key) + delta * DAY_MS).toISOString().slice(0, 10);

/**
 * Days are keyed by the calendar day on this computer's clock, so a day means something different in another
 * time zone. The zone is saved with the days, and a scan in a different zone does not mix the two (see below).
 */
export function currentTimeZone(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined;
  } catch {
    return undefined;
  }
}

/** True when saved days and the current clock use the same zone, or when either is not known (then nothing can be said against it). */
export function sameZone(saved: string | undefined, now: string | undefined): boolean {
  return !saved || !now || saved === now;
}

const count = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;

/** A saved day we can trust: real numbers only, and a plain table of models. Anything else returns null. */
function cleanDay(value: unknown): DayDetail | null {
  const d = value as Record<string, unknown> | null;
  if (!d || typeof d !== 'object') return null;
  const replies = count(d.count);
  const input = count(d.input);
  const output = count(d.output);
  const models = d.by_model as Record<string, Record<string, unknown>> | null;
  if (replies === null || input === null || output === null || !models || typeof models !== 'object') return null;

  const by_model: Models = Object.create(null);
  for (const [model, m] of Object.entries(models)) {
    if (!m || typeof m !== 'object') return null;
    const fields = [m.input, m.output, m.cache_read, m.cache_write, m.cache_write_1h].map(count);
    if (fields.some((f) => f === null)) return null;
    by_model[model] = {
      input: fields[0]!, output: fields[1]!, cache_read: fields[2]!, cache_write: fields[3]!, cache_write_1h: fields[4]!,
    };
  }
  const unfinished = count(d.unfinished);
  return { count: replies, input, output, ...(unfinished ? { unfinished } : {}), by_model };
}

/**
 * Combine stored days with this scan's days. When both have a day, keep the one with more replies,
 * so a partial day never replaces a complete one.
 *
 * When the stored days were kept in another time zone, their day boundaries are not this scan's, so a reply near
 * midnight could be in a stored day and in a scanned day next to it. Then the scan wins wherever it reaches
 * (and one day beyond), and only stored days clear of the scan are kept.
 */
export function mergeForSave(
  stored: Record<string, DayDetail>,
  current: Record<string, DayDetail>,
  options: { sameZone?: boolean } = {},
): Record<string, DayDetail> {
  const out: Record<string, DayDetail> = Object.create(null);
  const scanned = Object.keys(current).sort();
  const sameClock = options.sameZone ?? true;

  if (sameClock || scanned.length === 0) {
    Object.assign(out, stored);
  } else {
    const from = shiftDay(scanned[0], -1);
    const to = shiftDay(scanned[scanned.length - 1], 1);
    for (const [date, d] of Object.entries(stored)) if (date < from || date > to) out[date] = d;
  }

  for (const [date, d] of Object.entries(current)) {
    // A day with numbers that are not real (they would be written as null) never replaces what is saved
    if (!cleanDay(d)) continue;
    const old = out[date];
    if (!old || d.count >= old.count) out[date] = d;
  }
  return out;
}

export interface LoadedHistory {
  /** The days that could be read. */
  days: Record<string, DayDetail>;
  /** The time zone the days were kept in, when the file says. */
  timeZone?: string;
  /** Entries that could not be read. They are written back unchanged when the file is saved, so nothing is lost. */
  unreadable: Record<string, unknown>;
  /** Something plain to tell the user when the file could not be used fully. */
  warning?: string;
  /**
   * False when the file is there but could not be read at all (for example a permissions problem).
   * Saving then would replace it, so nothing is saved until it can be read.
   */
  safeToSave: boolean;
}

const emptyHistory = (): LoadedHistory => ({ days: Object.create(null), unreadable: Object.create(null), safeToSave: true });

/**
 * Read the saved days. A file that holds something other than saved days is moved aside (never deleted, never
 * overwritten) and the scan carries on without it. A file that cannot be opened at all is left exactly as it is.
 */
export function loadHistoryChecked(file = historyFile()): LoadedHistory {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return emptyHistory();
    return {
      ...emptyHistory(),
      safeToSave: false,
      warning: `Could not read your saved history (${(err as Error).message}). It was left as it is, and not updated.`,
    };
  }

  let parsed: any;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = null;
  }
  const usable = parsed && parsed.version === 1 && parsed.days && typeof parsed.days === 'object' && !Array.isArray(parsed.days);
  if (!usable) {
    const aside = `${file}.unreadable-${Date.now()}`;
    let moved = false;
    try {
      fs.renameSync(file, aside);
      moved = true;
    } catch { /* leave it where it is */ }
    return {
      ...emptyHistory(),
      // If it could not be moved, saving would replace it
      safeToSave: moved,
      warning: moved
        ? `Your saved history could not be read. It was kept as ${aside} and a new one will be started.`
        : 'Your saved history could not be read, and was left as it is. It was not updated.',
    };
  }

  const loaded = emptyHistory();
  if (typeof parsed.timeZone === 'string' && parsed.timeZone) loaded.timeZone = parsed.timeZone;
  let skipped = 0;
  for (const [date, value] of Object.entries(parsed.days)) {
    const day = /^\d{4}-\d{2}-\d{2}$/.test(date) ? cleanDay(value) : null;
    if (day) {
      loaded.days[date] = day;
    } else {
      skipped++;
      // Kept as it is, so saving never deletes something that only looks damaged to this version
      loaded.unreadable[date] = value;
    }
  }
  if (skipped > 0) {
    loaded.warning = `${skipped} saved day${skipped === 1 ? '' : 's'} could not be read and ${skipped === 1 ? 'was' : 'were'} skipped. ${skipped === 1 ? 'It stays' : 'They stay'} in the file.`;
  }
  return loaded;
}

export function loadHistory(file = historyFile()): Record<string, DayDetail> {
  return loadHistoryChecked(file).days;
}

/**
 * Write atomically, with owner-only permissions. `unreadable` entries from the last load are written back unchanged
 * (a day that was read and saved again replaces its unreadable copy), and the time zone of the days is recorded.
 */
export function saveHistory(
  days: Record<string, DayDetail>,
  file = historyFile(),
  extra: { unreadable?: Record<string, unknown>; timeZone?: string } = {},
): void {
  ensurePrivateFolder(path.dirname(file));
  const out: Record<string, unknown> = Object.create(null);
  Object.assign(out, extra.unreadable ?? {}, days);
  const body: Record<string, unknown> = { version: 1 };
  if (extra.timeZone) body.timeZone = extra.timeZone;
  body.days = out;
  writePrivateFile(file, JSON.stringify(body, null, 2));
}

/** Add (sign 1) or take away (sign -1) one day's totals from a report. */
function applyDay(report: UsageReport, d: DayDetail, sign: 1 | -1): void {
  const tokens = report.usage.tokens;
  tokens.input += sign * d.input;
  tokens.output += sign * d.output;
  for (const [model, m] of Object.entries(d.by_model)) {
    const t = tokens.by_model[model] || zeroModel();
    t.input += sign * m.input;
    t.output += sign * m.output;
    t.cache_read = (t.cache_read || 0) + sign * m.cache_read;
    t.cache_write = (t.cache_write || 0) + sign * m.cache_write;
    t.cache_write_1h = (t.cache_write_1h || 0) + sign * m.cache_write_1h;
    tokens.by_model[model] = t;
    tokens.cached = (tokens.cached || 0) + sign * (m.cache_read + m.cache_write + m.cache_write_1h);
  }
  report.usage.messages.count += sign * d.count;
  report.usage.messages.unfinished = (report.usage.messages.unfinished || 0) + sign * (d.unfinished || 0);
}

/**
 * Bring saved days into the report: days the current scan did not see (Claude Code has deleted those
 * transcripts), and days where the saved copy has more replies than the scan found (part of that day's
 * transcripts is gone). Returns how many days came from the saved history.
 *
 * When the saved days were kept in a different time zone, only days clear of the scan are used. Otherwise a reply
 * near midnight could be counted twice, once in each zone's version of the day.
 */
export function addHistoryToReport(
  report: UsageReport,
  current: Record<string, DayDetail>,
  stored: Record<string, DayDetail>,
  options: { sameZone?: boolean } = {},
): number {
  let used = 0;
  const sameClock = options.sameZone ?? true;
  const scanned = Object.keys(current).sort();
  const clearBefore = !sameClock && scanned.length > 0 ? shiftDay(scanned[0], -1) : null;
  const clearAfter = !sameClock && scanned.length > 0 ? shiftDay(scanned[scanned.length - 1], 1) : null;

  for (const [date, d] of Object.entries(stored)) {
    if (clearBefore && clearAfter && date >= clearBefore && date <= clearAfter) continue;

    const seen = current[date];
    if (seen && seen.count >= d.count) continue;

    if (seen) {
      applyDay(report, seen, -1);
      for (const model of Object.keys(seen.by_model)) {
        const t = report.usage.tokens.by_model[model];
        if (t && !t.input && !t.output && !t.cache_read && !t.cache_write && !t.cache_write_1h) delete report.usage.tokens.by_model[model];
      }
      report.usage.messages.by_day = report.usage.messages.by_day.filter((x) => x.date !== date);
    }

    used++;
    applyDay(report, d, 1);
    report.usage.messages.by_day.push({ date, count: d.count, input: d.input, output: d.output } as DayUsage);
  }

  report.usage.messages.by_day.sort((a, b) => a.date.localeCompare(b.date));
  if (used > 0 && report.usage.messages.by_day.length > 0) {
    const first = report.usage.messages.by_day[0].date.split('-').map(Number);
    const last = report.usage.messages.by_day[report.usage.messages.by_day.length - 1].date.split('-').map(Number);
    report.period.start = new Date(first[0], first[1] - 1, first[2]).toISOString();
    report.period.end = new Date(last[0], last[1] - 1, last[2], 23, 59, 59).toISOString();
  }
  return used;
}
