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
  by_model: Record<string, { input: number; output: number; cache_read: number; cache_write: number }>;
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
  const seenReplies = new Set<string>();
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

  for (const file of files) {
    progress.filesProcessed++;

    let content: string;
    try {
      content = fs.readFileSync(file, 'utf-8');
    } catch {
      progress.errors.push(`Could not read: ${file}`);
      continue;
    }

    for (const line of content.split('\n')) {
      const entry = parseJsonlLine(line);
      const msg = entry?.message;
      if (!entry || !msg?.usage) continue;

      let ts: Date | null = entry.timestamp ? new Date(entry.timestamp) : null;
      if (ts && Number.isNaN(ts.getTime())) ts = null;

      // With a date window, entries without a timestamp cannot be placed, so they are left out
      if (hasRange && (!ts || (rangeStart && ts < rangeStart) || (rangeEnd && ts >= rangeEnd))) continue;

      // Count each API response once. Use the message id, then the request id.
      const replyKey = msg.id || entry.requestId || null;
      if (replyKey) {
        if (seenReplies.has(replyKey)) {
          progress.duplicatesSkipped++;
          continue;
        }
        seenReplies.add(replyKey);
      }

      const input = msg.usage.input_tokens || 0;
      const output = msg.usage.output_tokens || 0;
      const cacheRead = msg.usage.cache_read_input_tokens || 0;
      const cacheWrite = msg.usage.cache_creation_input_tokens || 0;
      const model = msg.model || 'unknown';

      const tokens = report.usage.tokens;
      tokens.input += input;
      tokens.output += output;
      tokens.cached = (tokens.cached || 0) + cacheRead + cacheWrite;

      const modelTotals = tokens.by_model[model] || { input: 0, output: 0, cache_read: 0, cache_write: 0 };
      modelTotals.input += input;
      modelTotals.output += output;
      modelTotals.cache_read = (modelTotals.cache_read || 0) + cacheRead;
      modelTotals.cache_write = (modelTotals.cache_write || 0) + cacheWrite;
      tokens.by_model[model] = modelTotals;

      report.usage.messages.count++;
      progress.messagesProcessed++;
      sessionIds.add(entry.sessionId || file);

      if (ts) {
        if (!minTs || ts < minTs) minTs = ts;
        if (!maxTs || ts > maxTs) maxTs = ts;

        const day = localDayKey(ts);
        const detail = dayDetail[day] || { count: 0, input: 0, output: 0, by_model: {} };
        detail.count++;
        detail.input += input;
        detail.output += output;
        const dm = detail.by_model[model] || { input: 0, output: 0, cache_read: 0, cache_write: 0 };
        dm.input += input;
        dm.output += output;
        dm.cache_read += cacheRead;
        dm.cache_write += cacheWrite;
        detail.by_model[model] = dm;
        dayDetail[day] = detail;
      }
    }

    onProgress?.(progress);
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
