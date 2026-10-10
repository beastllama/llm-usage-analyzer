// OpenAI Codex CLI keeps a JSONL "rollout" per session under $CODEX_HOME (default ~/.codex):
// sessions/YYYY/MM/DD/rollout-*.jsonl, and archived_sessions/rollout-*.jsonl. Older files may be zstd-compressed (.jsonl.zst).
//
// How usage is counted (from Codex's own source, codex-rs, checked 2026-10-10):
//  - Since rust-v0.153.0 each API response writes a `token_usage_record` line with that response's exact usage and its
//    `response_id`. These are the main source, counted once per response_id across all files: a forked session copies
//    its parent's lines, ids included.
//  - Older files only have `event_msg` / `token_count` lines with running totals. One is counted when its running total
//    moved and no record already covered that response. A `token_count` with `info: null`, or with the same total as
//    the last one (rate-limit updates, retries), is not usage. Copied lines are recognised by their totals: the same
//    totals in two files are one response, counted once.
//  - `input_tokens` includes the cached and cache-write tokens, and `output_tokens` includes the reasoning tokens.
//  - The model is the one in the latest `turn_context` line before the usage line.
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as zlib from 'zlib';
import type { ScanOptions } from '../types.js';
import {
  type ParseProgress, type Reply, type ScanResult,
  addError, aggregate, dateWindow, emptyReport, findFiles, forEachLine, modelName, newProgress, parseJsonLine,
  plausibleTime, readFiles, tokenCount, MAX_LINE_CHARS,
} from './common.js';

/** Codex's home: CODEX_HOME when set and not empty, else ~/.codex (as in Codex itself). */
export function codexHome(): string {
  return process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
}

/** The folder whose presence means Codex has been used here. */
export const getCodexDataPath = (): string => path.join(codexHome(), 'sessions');

const isRollout = (name: string): boolean => name.startsWith('rollout-') && (name.endsWith('.jsonl') || name.endsWith('.jsonl.zst'));

/** Node can unpack zstd from 22.15 / 23.8 on. Older versions skip compressed files, and the report says the total is a minimum. */
const zstd = (zlib as unknown as { zstdDecompressSync?: (buf: Buffer) => Buffer }).zstdDecompressSync;

interface Usage {
  input: number;
  cached: number;
  cacheWrite: number;
  output: number;
}

function readUsage(value: unknown): Usage | null {
  if (!value || typeof value !== 'object') return null;
  const u = value as Record<string, unknown>;
  return {
    input: tokenCount(u.input_tokens),
    cached: tokenCount(u.cached_input_tokens),
    cacheWrite: tokenCount(u.cache_write_input_tokens),
    output: tokenCount(u.output_tokens),
  };
}

const sameUsage = (a: Usage | null, b: Usage | null): boolean =>
  a !== null && b !== null && a.input === b.input && a.cached === b.cached && a.cacheWrite === b.cacheWrite && a.output === b.output;

const isEmpty = (u: Usage): boolean => u.input === 0 && u.cached === 0 && u.cacheWrite === 0 && u.output === 0;

/** One response's usage, with where it was found. */
interface Found {
  usage: Usage;
  model: string;
  ts: Date | null;
  sessionId: string;
  /** True when the line was written by the session that owns the file (not copied from a parent). */
  own: boolean;
  /** Fast mode costs more, and is not in the price table, so it is filed apart (and reported as unpriced). */
  fast: boolean;
}

/** Keep one copy of a response: the session's own over a copy, and then the earliest. */
function better(a: Found, b: Found): Found {
  if (a.own !== b.own) return a.own ? a : b;
  if (a.ts && b.ts) return a.ts <= b.ts ? a : b;
  return a;
}

export async function scanCodexUsage(
  options: ScanOptions = {},
  onProgress?: (progress: ParseProgress) => void,
): Promise<ScanResult> {
  const progress = newProgress();
  const nowMs = Date.now();
  const window = dateWindow(options, nowMs);
  const report = emptyReport('chatgpt', 'Codex CLI', 'openai', nowMs);
  const home = codexHome();

  const files: string[] = [];
  for (const sub of ['sessions', 'archived_sessions']) {
    const dir = path.join(home, sub);
    if (fs.existsSync(dir)) files.push(...findFiles(dir, isRollout, progress.errors));
  }
  if (files.length === 0 && !fs.existsSync(getCodexDataPath())) {
    addError(progress, `Codex CLI data folder not found: ${getCodexDataPath()}`);
    return { report, progress, dayDetail: Object.create(null) };
  }
  // The same rollout can be in both folders (archived, then not) and in both forms; read each one once, plain first
  const byName = new Map<string, string>();
  for (const file of files.sort((a, b) => Number(a.endsWith('.zst')) - Number(b.endsWith('.zst')))) {
    const name = path.basename(file).replace(/\.zst$/, '');
    if (!byName.has(name)) byName.set(name, file);
  }
  progress.projectsFound = byName.size;
  onProgress?.(progress);

  const records = new Map<string, Found>();   // by response_id
  const counted = new Map<string, Found>();   // by running totals, for files without records
  let compressedSkipped = 0;

  const readOne = async (file: string, size: number): Promise<void> => {
    // State for this file
    let selfId = file;
    let firstMeta = true;
    let copiedPrefix = false;       // a forked session starts with a copy of its parent
    let subagentStart: number | null = null;
    let model = 'unknown';
    let fast = false;
    let prevTotal: Usage | null = null;
    let recordsSinceAdvance = 0;

    const onLine = (line: string): void => {
      // Only a few line types matter. Skip the rest (messages, tool calls) without parsing them.
      if (!line.includes('"session_meta"') && !line.includes('"turn_context"') && !line.includes('"token_usage_record"') &&
          !line.includes('"token_count"') && !line.includes('"thread_settings_applied"')) return;
      const entry = parseJsonLine<{ timestamp?: unknown; ordinal?: unknown; type?: unknown; payload?: Record<string, unknown> }>(line);
      if (!entry || typeof entry !== 'object' || !entry.payload || typeof entry.payload !== 'object') return;
      const p = entry.payload;

      if (entry.type === 'session_meta') {
        // Only the first one describes this file. Later ones are copied from a parent.
        if (!firstMeta) return;
        firstMeta = false;
        if (typeof p.id === 'string' && p.id) selfId = p.id;
        copiedPrefix = typeof p.forked_from_id === 'string' && !p.history_base && p.subagent_history_start_ordinal == null;
        if (typeof p.subagent_history_start_ordinal === 'number') subagentStart = p.subagent_history_start_ordinal;
        return;
      }
      // A subagent's file starts with its parent's context, below this line number
      if (subagentStart !== null && typeof entry.ordinal === 'number' && entry.ordinal < subagentStart) return;

      if (entry.type === 'turn_context') {
        if (typeof p.model === 'string' && p.model) model = modelName(p.model);
        return;
      }

      if (entry.type === 'event_msg' && p.type === 'thread_settings_applied') {
        const settings = p.thread_settings as Record<string, unknown> | undefined;
        if (p.thread_id === selfId) {
          // The fork's own settings come right after the copied part
          copiedPrefix = false;
          if (settings && typeof settings.model === 'string' && settings.model) model = modelName(settings.model);
        }
        if (settings) fast = settings.service_tier === 'priority' || settings.service_tier === 'fast';
        return;
      }

      const ts = plausibleTime(entry.timestamp, nowMs);

      if (entry.type === 'token_usage_record') {
        recordsSinceAdvance++;
        const usage = readUsage(p.usage);
        const id = typeof p.response_id === 'string' && p.response_id ? p.response_id : null;
        if (!usage || !id || isEmpty(usage)) return;
        const found: Found = { usage, model, ts, sessionId: selfId, own: p.thread_id === selfId, fast };
        const seen = records.get(id);
        records.set(id, seen ? better(seen, found) : found);
        if (seen) progress.duplicatesSkipped++;
        return;
      }

      if (entry.type === 'event_msg' && p.type === 'token_count') {
        const info = p.info as Record<string, unknown> | null | undefined;
        if (!info || typeof info !== 'object') return; // rate limits only
        const total = readUsage(info.total_token_usage);
        if (!total || sameUsage(total, prevTotal)) return; // nothing new
        const covered = recordsSinceAdvance > 0;
        const before = prevTotal;
        prevTotal = total;
        recordsSinceAdvance = 0;
        if (covered || copiedPrefix) return;

        let usage = readUsage(info.last_token_usage);
        if (!usage && before) {
          usage = {
            input: Math.max(0, total.input - before.input),
            cached: Math.max(0, total.cached - before.cached),
            cacheWrite: Math.max(0, total.cacheWrite - before.cacheWrite),
            output: Math.max(0, total.output - before.output),
          };
        }
        if (!usage || isEmpty(usage)) return; // a recount after compaction, not a response
        const key = JSON.stringify([total, usage]);
        const found: Found = { usage, model, ts, sessionId: selfId, own: true, fast };
        const seen = counted.get(key);
        counted.set(key, seen ? better(seen, found) : found);
        if (seen) progress.duplicatesSkipped++;
      }
    };

    if (file.endsWith('.zst')) {
      if (!zstd) {
        compressedSkipped++;
        return;
      }
      const text = zstd(fs.readFileSync(file)).toString('utf8');
      text.split('\n').forEach((line) => onLine(line));
      return;
    }
    await forEachLine(file, size, (line) => onLine(line),
      () => addError(progress, `Skipped a line longer than ${MAX_LINE_CHARS / (1024 * 1024)} MB in: ${file}`));
  };

  await readFiles([...byName.values()], progress, onProgress, readOne);

  if (compressedSkipped > 0) {
    addError(progress, `${compressedSkipped} compressed Codex session file(s) were not read: this needs Node 22.15 or newer.`);
    report.usage.incomplete = true;
  }

  const replies: Reply[] = [];
  for (const found of [...records.values(), ...counted.values()]) {
    if (!window.contains(found.ts)) continue;
    const { usage } = found;
    const cacheWrite = Math.min(usage.cacheWrite, Math.max(0, usage.input - usage.cached));
    replies.push({
      model: found.fast ? `${found.model}-fast` : found.model,
      ts: found.ts,
      sessionId: found.sessionId,
      input: Math.max(0, usage.input - usage.cached - cacheWrite),
      output: usage.output,
      cacheRead: Math.min(usage.cached, usage.input),
      cacheWrite5m: cacheWrite,
      cacheWrite1h: 0,
      stopped: true,
    });
  }

  const dayDetail = aggregate(report, replies, progress);
  return { report, progress, dayDetail };
}
