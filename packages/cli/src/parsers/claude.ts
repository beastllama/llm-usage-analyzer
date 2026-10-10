import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type { ClaudeMessage, ScanOptions } from '../types.js';
import {
  type ParseProgress, type DayDetail, type Reply, type ScanResult,
  addError, aggregate, dateWindow, emptyReport, findFiles, forEachLine, modelName, newProgress, parseJsonLine,
  plausibleTime, readFiles, tokenCount, MAX_LINE_CHARS,
} from './common.js';

export { localDayKey, parseLocalDate, formatTokens, tokenCount } from './common.js';
export type { ParseProgress, DayDetail } from './common.js';

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
export const parseJsonlLine = (line: string): ClaudeMessage | null => parseJsonLine<ClaudeMessage>(line);

/** Find every .jsonl transcript under a directory. Skips symlinks, and never throws. */
export function findTranscripts(dir: string, errors: string[]): string[] {
  return findFiles(dir, (name) => name.endsWith('.jsonl'), errors);
}

/**
 * Scan Claude Code transcripts and aggregate usage.
 * One reply = one API response. Claude Code can write several lines for one response,
 * so lines are counted once per message id.
 */
export async function scanClaudeUsage(
  options: ScanOptions = {},
  onProgress?: (progress: ParseProgress) => void
): Promise<ScanResult> {
  const progress = newProgress();
  const nowMs = Date.now();
  const window = dateWindow(options, nowMs);
  const report = emptyReport('claude', 'Claude Code', 'anthropic', nowMs);

  if (!claudeDataExists()) {
    addError(progress, `Claude Code data folder not found: ${getClaudeDataPath()}`);
    return { report, progress, dayDetail: Object.create(null) };
  }

  const projectsDir = getClaudeDataPath();
  const files = findTranscripts(projectsDir, progress.errors);
  progress.projectsFound = new Set(files.map(f => path.dirname(path.relative(projectsDir, f)).split(path.sep)[0])).size;
  onProgress?.(progress);

  // One entry per reply. A reply can appear on several lines. Every count keeps the largest value
  // seen for that reply, and the reply is "stopped" if any line says how it ended.
  const replies = new Map<string, Reply>();

  const handleLine = (file: string, line: string, i: number) => {
    // Most lines are prompts and tool results. Only an assistant line has a "usage" key, so skip the rest cheaply.
    if (!line.includes('"usage"')) return;
    const entry = parseJsonlLine(line);
    const msg = entry?.message;
    if (!entry || !msg || typeof msg !== 'object' || !msg.usage || typeof msg.usage !== 'object') return;
    // Claude Code writes placeholder rows (no real API call) for interrupted turns and API errors
    if (msg.model === '<synthetic>' || entry.isApiErrorMessage === true) return;

    const ts = plausibleTime(entry.timestamp, nowMs);
    // With a date window, entries without a usable timestamp cannot be placed, so they are left out
    if (!window.contains(ts)) return;

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
      model: modelName(msg.model),
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

  await readFiles(files, progress, onProgress, (file, size) =>
    forEachLine(
      file,
      size,
      (line, i) => handleLine(file, line, i),
      () => addError(progress, `Skipped a line longer than ${MAX_LINE_CHARS / (1024 * 1024)} MB in: ${file}`),
    ));

  const dayDetail = aggregate(report, replies.values(), progress);
  return { report, progress, dayDetail };
}
