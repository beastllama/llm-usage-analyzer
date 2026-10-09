import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type { ClaudeMessage, UsageReport, ScanOptions, DayUsage } from '../types.js';

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
      errors.push(`Could not read folder: ${current}`);
      return;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
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

/** One API response, as read from the transcript. */
interface Reply {
  model: string;
  ts: Date | null;
  sessionId: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cacheWrite1h: number;
  cacheWriteAll: number;
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

  // Date window. The end date includes its whole day.
  let rangeStart: Date | null = null;
  let rangeEnd: Date | null = null;
  if (options.days) {
    rangeEnd = new Date();
    rangeStart = new Date(Date.now() - options.days * 24 * 60 * 60 * 1000);
  }
  if (options.startDate) {
    rangeStart = parseLocalDate(options.startDate) ?? rangeStart;
  }
  if (options.endDate) {
    const end = parseLocalDate(options.endDate);
    if (end) rangeEnd = new Date(end.getFullYear(), end.getMonth(), end.getDate() + 1);
  }
  const hasRange = rangeStart !== null || rangeEnd !== null;

  const now = new Date();
  const report: UsageReport = {
    provider: 'anthropic',
    source: 'local_agent',
    period: { start: now.toISOString(), end: now.toISOString() },
    // Plan is chosen in the dashboard, so the scan does not assume one
    plan: { name: 'Not set', price_usd: 0, type: 'subscription' },
    usage: {
      tokens: { input: 0, output: 0, cached: 0, by_model: {} },
      messages: { count: 0, by_day: [] },
      sessions: { count: 0 },
    },
  };

  const dayDetail: Record<string, DayDetail> = {};
  const sessionIds = new Set<string>();
  let minTs: Date | null = null;
  let maxTs: Date | null = null;

  if (!claudeDataExists()) {
    progress.errors.push(`Claude Code data folder not found: ${getClaudeDataPath()}`);
    return { report, progress, dayDetail };
  }

  const projectsDir = getClaudeDataPath();
  const files = findTranscripts(projectsDir, progress.errors);
  progress.projectsFound = new Set(files.map(f => path.dirname(path.relative(projectsDir, f)).split(path.sep)[0])).size;
  onProgress?.(progress);

  // Pass 1: one entry per reply. A reply can appear on several lines, and later lines can
  // carry a larger output count, so the largest output seen for each reply is kept.
  const replies = new Map<string, Reply>();

  for (const file of files) {
    progress.filesProcessed++;

    let content: string;
    try {
      content = fs.readFileSync(file, 'utf-8');
    } catch {
      progress.errors.push(`Could not read: ${file}`);
      continue;
    }

    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const entry = parseJsonlLine(lines[i]);
      const msg = entry?.message;
      if (!entry || !msg?.usage) continue;

      let ts: Date | null = entry.timestamp ? new Date(entry.timestamp) : null;
      if (ts && Number.isNaN(ts.getTime())) ts = null;

      // With a date window, entries without a timestamp cannot be placed, so they are left out
      if (hasRange && (!ts || (rangeStart && ts < rangeStart) || (rangeEnd && ts >= rangeEnd))) continue;

      const output = msg.usage.output_tokens || 0;
      // Use the message id, then the request id. A line with neither is its own reply.
      const key = msg.id || entry.requestId || `${file}#${i}`;
      const existing = replies.get(key);
      if (existing) {
        progress.duplicatesSkipped++;
        existing.output = Math.max(existing.output, output);
        continue;
      }

      const creation = msg.usage.cache_creation;
      const cacheWriteAll = msg.usage.cache_creation_input_tokens || 0;
      const cacheWrite1h = creation?.ephemeral_1h_input_tokens || 0;
      replies.set(key, {
        model: msg.model || 'unknown',
        ts,
        sessionId: entry.sessionId || file,
        input: msg.usage.input_tokens || 0,
        output,
        cacheRead: msg.usage.cache_read_input_tokens || 0,
        // Writes are split by cache lifetime when the log says so (1-hour writes cost more).
        // Older logs have no split, so every write is treated as 5-minute.
        cacheWrite: creation
          ? (creation.ephemeral_5m_input_tokens ?? Math.max(0, cacheWriteAll - cacheWrite1h))
          : cacheWriteAll,
        cacheWrite1h,
        cacheWriteAll,
      });
    }

    onProgress?.(progress);
  }

  // Pass 2: totals from the replies
  const tokens = report.usage.tokens;
  for (const r of replies.values()) {
    let model = r.model;
    // Haiku 5.5 bills a whole request at a higher rate when its prompt is over 100K tokens
    const promptTokens = r.input + r.cacheRead + r.cacheWriteAll;
    if (model.startsWith('claude-haiku-5-5') && promptTokens > 100_000) model = 'claude-haiku-5-5-long-prompt';

    tokens.input += r.input;
    tokens.output += r.output;
    tokens.cached = (tokens.cached || 0) + r.cacheRead + r.cacheWrite + r.cacheWrite1h;

    const modelTotals = tokens.by_model[model] || { input: 0, output: 0, cache_read: 0, cache_write: 0, cache_write_1h: 0 };
    modelTotals.input += r.input;
    modelTotals.output += r.output;
    modelTotals.cache_read = (modelTotals.cache_read || 0) + r.cacheRead;
    modelTotals.cache_write = (modelTotals.cache_write || 0) + r.cacheWrite;
    modelTotals.cache_write_1h = (modelTotals.cache_write_1h || 0) + r.cacheWrite1h;
    tokens.by_model[model] = modelTotals;

    report.usage.messages.count++;
    progress.messagesProcessed++;
    sessionIds.add(r.sessionId);

    if (r.ts) {
      if (!minTs || r.ts < minTs) minTs = r.ts;
      if (!maxTs || r.ts > maxTs) maxTs = r.ts;

      const day = localDayKey(r.ts);
      const detail = dayDetail[day] || { count: 0, input: 0, output: 0, by_model: {} };
      detail.count++;
      detail.input += r.input;
      detail.output += r.output;
      const dm = detail.by_model[model] || { input: 0, output: 0, cache_read: 0, cache_write: 0, cache_write_1h: 0 };
      dm.input += r.input;
      dm.output += r.output;
      dm.cache_read += r.cacheRead;
      dm.cache_write += r.cacheWrite;
      dm.cache_write_1h += r.cacheWrite1h;
      detail.by_model[model] = dm;
      dayDetail[day] = detail;
    }
  }

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
