// What every reader of a local AI tool's logs shares: finding the files, reading them line by line without running
// out of memory, checking numbers and timestamps, the date window, and turning replies into a report.
import * as fs from 'fs';
import * as path from 'path';
import { StringDecoder } from 'string_decoder';
import type { UsageReport, ScanOptions, DayUsage, ProductId } from '../types.js';
import { plain } from '../fsafe.js';
import { billingKey } from '../pricing.js';

export interface ParseProgress {
  projectsFound: number;
  filesProcessed: number;
  messagesProcessed: number;
  duplicatesSkipped: number;
  errors: string[];
}

export interface DayDetail {
  count: number;
  input: number;
  output: number;
  /** Replies whose log never recorded how they ended, so their output count may be cut short. */
  unfinished?: number;
  by_model: Record<string, { input: number; output: number; cache_read: number; cache_write: number; cache_write_1h: number }>;
}

/** One billed model response, as read from a log. Input never includes cached tokens: those are counted apart. */
export interface Reply {
  model: string;
  ts: Date | null;
  sessionId: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  /** False when the log never recorded how the reply ended, so its output may be cut short. */
  stopped: boolean;
}

export interface ScanResult {
  report: UsageReport;
  progress: ParseProgress;
  dayDetail: Record<string, DayDetail>;
}

// Limits that keep a strange file from stalling or crashing a scan
const SMALL_FILE_BYTES = 8 * 1024 * 1024;   // read whole, which is fastest
const CHUNK_BYTES = 1024 * 1024;            // bigger files are read a chunk at a time
export const MAX_LINE_CHARS = 32 * 1024 * 1024; // a longer line cannot be a usage record, so it is skipped
export const MAX_ERRORS_KEPT = 50;
const DAY_MS = 24 * 60 * 60 * 1000;
// None of these tools existed before this, so an older timestamp is a bad clock. A day ahead allows for time zones.
const EARLIEST_PLAUSIBLE = Date.UTC(2024, 0, 1);

// No real request comes near this (the biggest context windows are a few million tokens). A count above it is a damaged
// or invented log line, and counting it would turn a total into Infinity (and a saved file into nulls).
const MAX_TOKENS_PER_COUNT = 1_000_000_000;
// A model name longer than this is not a model name. It is cut, so one bad line cannot fill the terminal or the saved history.
export const MAX_MODEL_NAME_CHARS = 100;

/** A dictionary that accepts any key, including "__proto__" and "constructor". */
export const dictionary = <T>(): Record<string, T> => Object.create(null);

/** Parse one JSONL line. Returns null for a blank or broken line. */
export function parseJsonLine<T = unknown>(line: string): T | null {
  if (!line.trim()) return null;
  try {
    return JSON.parse(line) as T;
  } catch {
    return null;
  }
}

/** Local calendar day as YYYY-MM-DD. Days follow the user's clock, not UTC. */
export function localDayKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** Parse YYYY-MM-DD as a local calendar day. Returns null when the text is not a valid date. */
export function parseLocalDate(text: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (!match) return null;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const d = new Date(year, month - 1, day);
  // Reject dates JavaScript would roll over, such as 2026-02-31 or 2026-13-01
  if (d.getFullYear() !== year || d.getMonth() !== month - 1 || d.getDate() !== day) return null;
  return d;
}

/** A token count from a log: a whole number of 0 or more. Anything else (text, negative, NaN, absurdly large) counts as 0. */
export function tokenCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= MAX_TOKENS_PER_COUNT ? Math.floor(value) : 0;
}

/** A usable timestamp, or null when it is missing, invalid, before 2024, or more than a day in the future. */
export function plausibleTime(value: unknown, now: number): Date | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const d = new Date(value);
  const t = d.getTime();
  return Number.isNaN(t) || t < EARLIEST_PLAUSIBLE || t > now + DAY_MS ? null : d;
}

/** A model name from a log, cut to a sane length. */
export const modelName = (value: unknown): string =>
  typeof value === 'string' && value ? value.slice(0, MAX_MODEL_NAME_CHARS) : 'unknown';

export function newProgress(): ParseProgress {
  return { projectsFound: 0, filesProcessed: 0, messagesProcessed: 0, duplicatesSkipped: 0, errors: [] };
}

/** Keep an error for the --verbose list. Paths come from the disk and can hold control characters, so they are cleaned. */
export function addError(progress: ParseProgress, message: string): void {
  if (progress.errors.length < MAX_ERRORS_KEPT) progress.errors.push(plain(message).slice(0, 400));
}

/** The date window from the options. The end date includes its whole day. */
export interface DateWindow {
  start: Date | null;
  end: Date | null;
  /** True when a window is set. Then a reply without a usable timestamp cannot be placed, so it is left out. */
  active: boolean;
  /** True when the time is inside the window (or there is no window). */
  contains: (ts: Date | null) => boolean;
}

export function dateWindow(options: ScanOptions, nowMs: number): DateWindow {
  let start: Date | null = null;
  let end: Date | null = null;
  if (options.days) {
    end = new Date(nowMs);
    start = new Date(nowMs - options.days * DAY_MS);
  }
  if (options.startDate) start = parseLocalDate(options.startDate) ?? start;
  if (options.endDate) {
    const last = parseLocalDate(options.endDate);
    if (last) end = new Date(last.getFullYear(), last.getMonth(), last.getDate() + 1);
  }
  const active = start !== null || end !== null;
  return {
    start,
    end,
    active,
    contains: (ts) => !active || (ts !== null && (!start || ts >= start) && (!end || ts < end)),
  };
}

/**
 * Find every file under a folder whose name passes `wanted`. Skips links (they could lead anywhere, so what is behind
 * one is not counted, and it says so), and never throws.
 */
export function findFiles(dir: string, wanted: (name: string) => boolean, errors: string[]): string[] {
  const found: string[] = [];
  const walk = (current: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      if (errors.length < MAX_ERRORS_KEPT) errors.push(`Could not read folder: ${current}`);
      return;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) {
        if (errors.length < MAX_ERRORS_KEPT) errors.push(`Skipped a link, not counted: ${path.join(current, entry.name)}`);
        continue;
      }
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && wanted(entry.name)) found.push(full);
    }
  };
  walk(dir);
  return found;
}

/**
 * Call `onLine` for every line of a file. Small files are read whole. Big files are read a chunk at a time,
 * so a very large log cannot run out of memory, and the server can answer other requests in between.
 */
export async function forEachLine(
  file: string,
  size: number,
  onLine: (line: string, index: number) => void,
  onSkippedLine: () => void,
): Promise<void> {
  if (size <= SMALL_FILE_BYTES) {
    const lines = fs.readFileSync(file, 'utf-8').split('\n');
    for (let i = 0; i < lines.length; i++) onLine(i === 0 ? stripBom(lines[i]) : lines[i], i);
    return;
  }

  const handle = await fs.promises.open(file, 'r');
  try {
    const buffer = Buffer.allocUnsafe(CHUNK_BYTES);
    const decoder = new StringDecoder('utf8');
    let carry = '';
    let skipping = false;
    let index = 0;
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      const text = decoder.write(buffer.subarray(0, bytesRead));
      let start = 0;
      for (;;) {
        const newline = text.indexOf('\n', start);
        if (newline === -1) break;
        if (skipping) skipping = false; // the end of an over-long line
        else onLine(index === 0 ? stripBom(carry + text.slice(start, newline)) : carry + text.slice(start, newline), index);
        carry = '';
        index++;
        start = newline + 1;
      }
      if (!skipping) {
        carry += text.slice(start);
        if (carry.length > MAX_LINE_CHARS) {
          carry = '';
          skipping = true;
          onSkippedLine();
        }
      }
    }
    carry += decoder.end();
    if (!skipping && carry) onLine(index === 0 ? stripBom(carry) : carry, index);
  } finally {
    await handle.close();
  }
}

const stripBom = (line: string): string => (line.charCodeAt(0) === 0xfeff ? line.slice(1) : line);

/** Read each file in turn, keep going past a file that cannot be read, and let the server breathe during a long scan. */
export async function readFiles(
  files: string[],
  progress: ParseProgress,
  onProgress: ((progress: ParseProgress) => void) | undefined,
  readOne: (file: string, size: number) => Promise<void>,
): Promise<void> {
  let lastYield = Date.now();
  for (const file of files) {
    progress.filesProcessed++;
    try {
      await readOne(file, fs.statSync(file).size);
    } catch {
      addError(progress, `Could not read: ${file}`);
      continue;
    }
    onProgress?.(progress);
    if (Date.now() - lastYield > 40) {
      await new Promise<void>((resolve) => setImmediate(resolve));
      lastYield = Date.now();
    }
  }
}

/** A report with nothing in it yet, for the tool that is being read. */
export function emptyReport(product: ProductId, tool: string, provider: UsageReport['provider'], nowMs = Date.now()): UsageReport {
  const now = new Date(nowMs).toISOString();
  return {
    provider,
    product,
    tool,
    source: 'local_agent',
    period: { start: now, end: now },
    // The plan is chosen in the dashboard, so the scan does not assume one
    plan: { name: 'Not set', price_usd: 0, type: 'subscription' },
    usage: {
      tokens: { input: 0, output: 0, cached: 0, by_model: dictionary() },
      messages: { count: 0, by_day: [], unfinished: 0 },
      sessions: { count: 0 },
    },
  };
}

/** Add up the replies into the report and into one detail entry per local calendar day. */
export function aggregate(report: UsageReport, replies: Iterable<Reply>, progress: ParseProgress): Record<string, DayDetail> {
  const dayDetail: Record<string, DayDetail> = dictionary();
  const sessionIds = new Set<string>();
  const tokens = report.usage.tokens;
  let unfinishedTotal = 0;
  let minTs: Date | null = null;
  let maxTs: Date | null = null;

  for (const r of replies) {
    // Some models bill a whole request at a higher rate when its prompt is long, and some prices change on a known
    // day. Those requests are filed apart, under the price that applies to them.
    const model = billingKey(r.model, r.input + r.cacheRead + r.cacheWrite5m + r.cacheWrite1h, r.ts);

    tokens.input += r.input;
    tokens.output += r.output;
    tokens.cached = (tokens.cached || 0) + r.cacheRead + r.cacheWrite5m + r.cacheWrite1h;

    const modelTotals = tokens.by_model[model] || { input: 0, output: 0, cache_read: 0, cache_write: 0, cache_write_1h: 0 };
    modelTotals.input += r.input;
    modelTotals.output += r.output;
    modelTotals.cache_read = (modelTotals.cache_read || 0) + r.cacheRead;
    modelTotals.cache_write = (modelTotals.cache_write || 0) + r.cacheWrite5m;
    modelTotals.cache_write_1h = (modelTotals.cache_write_1h || 0) + r.cacheWrite1h;
    tokens.by_model[model] = modelTotals;

    report.usage.messages.count++;
    if (!r.stopped) unfinishedTotal++;
    progress.messagesProcessed++;
    sessionIds.add(r.sessionId);

    if (r.ts) {
      if (!minTs || r.ts < minTs) minTs = r.ts;
      if (!maxTs || r.ts > maxTs) maxTs = r.ts;

      const day = localDayKey(r.ts);
      const detail = dayDetail[day] || { count: 0, input: 0, output: 0, by_model: dictionary() };
      detail.count++;
      if (!r.stopped) detail.unfinished = (detail.unfinished || 0) + 1;
      detail.input += r.input;
      detail.output += r.output;
      const dm = detail.by_model[model] || { input: 0, output: 0, cache_read: 0, cache_write: 0, cache_write_1h: 0 };
      dm.input += r.input;
      dm.output += r.output;
      dm.cache_read += r.cacheRead;
      dm.cache_write += r.cacheWrite5m;
      dm.cache_write_1h += r.cacheWrite1h;
      detail.by_model[model] = dm;
      dayDetail[day] = detail;
    }
  }

  report.usage.messages.unfinished = unfinishedTotal;
  report.usage.sessions.count = sessionIds.size;
  if (minTs) report.period.start = minTs.toISOString();
  if (maxTs) report.period.end = maxTs.toISOString();

  report.usage.messages.by_day = Object.entries(dayDetail)
    .map(([date, d]): DayUsage => ({ date, count: d.count, input: d.input, output: d.output }))
    .sort((a, b) => a.date.localeCompare(b.date));
  return dayDetail;
}

/** Format a token count for the terminal */
export function formatTokens(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(2)}M`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(1)}K`;
  return count.toString();
}
