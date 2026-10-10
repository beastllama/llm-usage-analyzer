import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { StringDecoder } from 'string_decoder';
import type { ClaudeMessage, UsageReport, ScanOptions, DayUsage } from '../types.js';
import { plain } from '../fsafe.js';
import { priceFor } from '../pricing.js';

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

/** Where Claude Code keeps its data. CLAUDE_CONFIG_DIR overrides ~/.claude, as in Claude Code itself. */
export function claudeConfigDir(): string {
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
}

export function getClaudeDataPath(): string {
  return path.join(claudeConfigDir(), 'projects');
}

/** Check if Claude Code data directory exists */
export function claudeDataExists(): boolean {
  return fs.existsSync(getClaudeDataPath());
}

/** Parse a single JSONL line */
export function parseJsonlLine(line: string): ClaudeMessage | null {
  if (!line.trim()) return null;
  try {
    return JSON.parse(line) as ClaudeMessage;
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

/** Find every .jsonl transcript under a directory. Skips symlinks, and never throws. */
export function findTranscripts(dir: string, errors: string[]): string[] {
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
        // Links are not followed (they could lead anywhere), so what is behind one is not counted. Say so.
        if (errors.length < MAX_ERRORS_KEPT) errors.push(`Skipped a link, not counted: ${path.join(current, entry.name)}`);
        continue;
      }
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) found.push(full);
    }
  };
  walk(dir);
  return found;
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

// Limits that keep a strange file from stalling or crashing a scan
const SMALL_FILE_BYTES = 8 * 1024 * 1024;   // read whole, which is fastest
const CHUNK_BYTES = 1024 * 1024;            // bigger files are read a chunk at a time
const MAX_LINE_CHARS = 32 * 1024 * 1024;    // a longer line cannot be a usage record, so it is skipped
const MAX_ERRORS_KEPT = 50;
const DAY_MS = 24 * 60 * 60 * 1000;
// Claude Code did not exist before this, so an older timestamp is a bad clock. A day ahead allows for time zones.
const EARLIEST_PLAUSIBLE = Date.UTC(2024, 0, 1);

// No real request comes near this (the biggest context windows are about a million tokens). A count above it is a damaged
// or invented log line, and counting it would turn a total into Infinity (and a saved file into nulls).
const MAX_TOKENS_PER_COUNT = 1_000_000_000;
// A model name longer than this is not a model name. It is cut, so one bad line cannot fill the terminal or the saved history.
const MAX_MODEL_NAME_CHARS = 100;

/** A token count from the log: a whole number of 0 or more. Anything else (text, negative, NaN, absurdly large) counts as 0. */
export function tokenCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= MAX_TOKENS_PER_COUNT ? Math.floor(value) : 0;
}

/** A usable timestamp, or null when it is missing, invalid, before 2024, or more than a day in the future. */
function plausibleTime(value: unknown, now: number): Date | null {
  if (typeof value !== 'string') return null;
  const d = new Date(value);
  const t = d.getTime();
  return Number.isNaN(t) || t < EARLIEST_PLAUSIBLE || t > now + DAY_MS ? null : d;
}

/** A dictionary that accepts any key, including "__proto__" and "constructor". */
const dictionary = <T>(): Record<string, T> => Object.create(null);

/** One API response, as read from the transcript. */
interface Reply {
  model: string;
  ts: Date | null;
  sessionId: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  /** True when some line of this reply says how it ended (a stop_reason). */
  stopped: boolean;
}

/**
 * Call `onLine` for every line of a file. Small files are read whole. Big files are read a chunk at a time,
 * so a very large transcript cannot run out of memory, and the server can answer other requests in between.
 */
async function forEachLine(
  file: string,
  size: number,
  onLine: (line: string, index: number) => void,
  onSkippedLine: () => void,
): Promise<void> {
  if (size <= SMALL_FILE_BYTES) {
    const lines = fs.readFileSync(file, 'utf-8').split('\n');
    for (let i = 0; i < lines.length; i++) onLine(lines[i], i);
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
        else onLine(carry + text.slice(start, newline), index);
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
    if (!skipping && carry) onLine(carry, index);
  } finally {
    await handle.close();
  }
}

/**
 * Scan Claude Code transcripts and aggregate usage.
 * One reply = one API response. Claude Code can write several lines for one response,
 * so lines are counted once per message id.
 */
export async function scanClaudeUsage(
  options: ScanOptions = {},
  onProgress?: (progress: ParseProgress) => void
): Promise<{ report: UsageReport; progress: ParseProgress; dayDetail: Record<string, DayDetail> }> {
  const progress: ParseProgress = {
    projectsFound: 0,
    filesProcessed: 0,
    messagesProcessed: 0,
    duplicatesSkipped: 0,
    errors: [],
  };
  const addError = (message: string) => {
    // Paths come from the disk and can hold control characters, so they are cleaned before they are kept (and later printed)
    if (progress.errors.length < MAX_ERRORS_KEPT) progress.errors.push(plain(message).slice(0, 400));
  };

  const nowMs = Date.now();

  // Date window. The end date includes its whole day.
  let rangeStart: Date | null = null;
  let rangeEnd: Date | null = null;
  if (options.days) {
    rangeEnd = new Date(nowMs);
    rangeStart = new Date(nowMs - options.days * DAY_MS);
  }
  if (options.startDate) {
    rangeStart = parseLocalDate(options.startDate) ?? rangeStart;
  }
  if (options.endDate) {
    const end = parseLocalDate(options.endDate);
    if (end) rangeEnd = new Date(end.getFullYear(), end.getMonth(), end.getDate() + 1);
  }
  const hasRange = rangeStart !== null || rangeEnd !== null;

  const now = new Date(nowMs);
  const report: UsageReport = {
    provider: 'anthropic',
    source: 'local_agent',
    period: { start: now.toISOString(), end: now.toISOString() },
    // Plan is chosen in the dashboard, so the scan does not assume one
    plan: { name: 'Not set', price_usd: 0, type: 'subscription' },
    usage: {
      tokens: { input: 0, output: 0, cached: 0, by_model: dictionary() },
      messages: { count: 0, by_day: [], unfinished: 0 },
      sessions: { count: 0 },
    },
  };

  const dayDetail: Record<string, DayDetail> = dictionary();
  const sessionIds = new Set<string>();
  let minTs: Date | null = null;
  let maxTs: Date | null = null;

  if (!claudeDataExists()) {
    addError(`Claude Code data folder not found: ${getClaudeDataPath()}`);
    return { report, progress, dayDetail };
  }

  const projectsDir = getClaudeDataPath();
  const files = findTranscripts(projectsDir, progress.errors);
  progress.projectsFound = new Set(files.map(f => path.dirname(path.relative(projectsDir, f)).split(path.sep)[0])).size;
  onProgress?.(progress);

  // Pass 1: one entry per reply. A reply can appear on several lines. Every count keeps the largest value
  // seen for that reply, and the reply is "stopped" if any line says how it ended.
  const replies = new Map<string, Reply>();

  const handleLine = (file: string, rawLine: string, i: number) => {
    // Most lines are prompts and tool results. Only an assistant line has a "usage" key, so skip the rest cheaply.
    if (!rawLine.includes('"usage"')) return;
    const line = i === 0 && rawLine.charCodeAt(0) === 0xfeff ? rawLine.slice(1) : rawLine;
    const entry = parseJsonlLine(line);
    const msg = entry?.message;
    if (!entry || !msg || typeof msg !== 'object' || !msg.usage || typeof msg.usage !== 'object') return;
    // Claude Code writes placeholder rows (no real API call) for interrupted turns and API errors
    if (msg.model === '<synthetic>' || entry.isApiErrorMessage === true) return;

    const ts = plausibleTime(entry.timestamp, nowMs);

    // With a date window, entries without a usable timestamp cannot be placed, so they are left out
    if (hasRange && (!ts || (rangeStart && ts < rangeStart) || (rangeEnd && ts >= rangeEnd))) return;

    const u = msg.usage;
    const input = tokenCount(u.input_tokens);
    const output = tokenCount(u.output_tokens);
    const cacheRead = tokenCount(u.cache_read_input_tokens);
    // Cache writes: the flat total is the whole, and the 1-hour part is a share of it. Anything the split
    // does not account for is treated as 5-minute, so a split that covers only part of the writes cannot lose tokens.
    const flatWrites = tokenCount(u.cache_creation_input_tokens);
    const split5m = tokenCount(u.cache_creation?.ephemeral_5m_input_tokens);
    const split1h = tokenCount(u.cache_creation?.ephemeral_1h_input_tokens);
    const allWrites = Math.max(flatWrites, split5m + split1h);
    const cacheWrite1h = Math.min(split1h, allWrites);
    const cacheWrite5m = allWrites - cacheWrite1h;
    const stopped = msg.stop_reason != null;

    // Use the message id, then the request id. A line with neither is its own reply.
    const key = (typeof msg.id === 'string' && msg.id) || (typeof entry.requestId === 'string' && entry.requestId) || `${file}#${i}`;
    const existing = replies.get(key);
    if (existing) {
      progress.duplicatesSkipped++;
      existing.input = Math.max(existing.input, input);
      existing.output = Math.max(existing.output, output);
      existing.cacheRead = Math.max(existing.cacheRead, cacheRead);
      existing.cacheWrite5m = Math.max(existing.cacheWrite5m, cacheWrite5m);
      existing.cacheWrite1h = Math.max(existing.cacheWrite1h, cacheWrite1h);
      existing.stopped = existing.stopped || stopped;
      return;
    }

    replies.set(key, {
      model: typeof msg.model === 'string' && msg.model ? msg.model.slice(0, MAX_MODEL_NAME_CHARS) : 'unknown',
      ts,
      sessionId: (typeof entry.sessionId === 'string' && entry.sessionId) || file,
      input,
      output,
      cacheRead,
      cacheWrite5m,
      cacheWrite1h,
      stopped,
    });
  };

  let lastYield = Date.now();
  for (const file of files) {
    progress.filesProcessed++;

    try {
      const size = fs.statSync(file).size;
      await forEachLine(
        file,
        size,
        (line, i) => handleLine(file, line, i),
        () => addError(`Skipped a line longer than ${MAX_LINE_CHARS / (1024 * 1024)} MB in: ${file}`),
      );
    } catch {
      addError(`Could not read: ${file}`);
      continue;
    }

    onProgress?.(progress);
    // Let the server answer other requests during a long scan
    if (Date.now() - lastYield > 40) {
      await new Promise<void>((resolve) => setImmediate(resolve));
      lastYield = Date.now();
    }
  }

  // Pass 2: totals from the replies
  const tokens = report.usage.tokens;
  let unfinishedTotal = 0;
  for (const r of replies.values()) {
    let model = r.model;
    // Haiku 5.5 bills a whole request at a higher rate when its prompt is over 100K tokens.
    // Only a model the price table knows as Haiku 5.5 is moved: a name that merely starts the same is not guessed at.
    const promptTokens = r.input + r.cacheRead + r.cacheWrite5m + r.cacheWrite1h;
    if (promptTokens > 100_000 && priceFor(model) === priceFor('claude-haiku-5-5')) model = 'claude-haiku-5-5-long-prompt';

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

  return { report, progress, dayDetail };
}

/** Format token count for display */
export function formatTokens(count: number): string {
  if (count >= 1_000_000) {
    return `${(count / 1_000_000).toFixed(2)}M`;
  } else if (count >= 1_000) {
    return `${(count / 1_000).toFixed(1)}K`;
  }
  return count.toString();
}
