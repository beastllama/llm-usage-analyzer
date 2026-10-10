// Google Gemini CLI records every chat under <home>/.gemini/tmp/<project>/chats/ (home is GEMINI_CLI_HOME when set,
// else the user's home folder). Since v0.39 a chat is a .jsonl log; up to v0.38 it was one .json file.
//
// How usage is counted (from Gemini CLI's own source, checked 2026-10-10):
//  - Each reply is a message of type "gemini" with its own `model`, `timestamp` and `tokens`.
//  - A message is written again when it changes (tokens attached, tool calls finished), and the same chat can be in
//    several files (a .json and the .jsonl made from it on resume; an old hash-named project folder and its copy under
//    the new name). So each reply is counted once, by session id and message id, across all files.
//  - Rewound replies ($rewindTo) are counted: they were sent and billed, the screen only hides them.
//  - `input` includes `cached`; `thoughts` are separate from `output` and billed at the output rate; `tool` (results of
//    server-side tools, given back to the model as input) is counted as input.
//  - Gemini CLI deletes chats older than 30 days by default, so saved history (see report.ts) keeps older days.
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type { ScanOptions } from '../types.js';
import {
  type ParseProgress, type Reply, type ScanResult,
  addError, aggregate, dateWindow, emptyReport, findFiles, forEachLine, modelName, newProgress, parseJsonLine,
  plausibleTime, readFiles, tokenCount, MAX_LINE_CHARS,
} from './common.js';

/** Gemini CLI's home: GEMINI_CLI_HOME (the folder that holds .gemini) when set, else the user's home folder. */
export function geminiHome(): string {
  return process.env.GEMINI_CLI_HOME || os.homedir();
}

/** The folder whose presence means Gemini CLI has been used here. */
export const getGeminiDataPath = (): string => path.join(geminiHome(), '.gemini', 'tmp');

// Under the macOS sandbox, Gemini CLI keeps its runtime folder here instead
const sandboxDataPath = (): string => path.join(geminiHome(), '.cache', '.gemini', 'tmp');

/** A legacy .json chat is read whole. One bigger than this is not a chat file. */
const MAX_JSON_BYTES = 256 * 1024 * 1024;

/** A chat file: inside a `chats` folder (or a subagent folder in it), named .json or .jsonl. */
const isChatFile = (file: string): boolean => {
  const name = path.basename(file);
  if (!(name.endsWith('.jsonl') || name.endsWith('.json'))) return false;
  return file.split(path.sep).includes('chats');
};

interface Message {
  model: string;
  ts: Date | null;
  sessionId: string;
  input: number;
  cached: number;
  output: number;
}

export async function scanGeminiUsage(
  options: ScanOptions = {},
  onProgress?: (progress: ParseProgress) => void,
): Promise<ScanResult> {
  const progress = newProgress();
  const nowMs = Date.now();
  const window = dateWindow(options, nowMs);
  const report = emptyReport('gemini-api', 'Gemini CLI', 'google', nowMs);

  const roots = [getGeminiDataPath(), sandboxDataPath()].filter((dir) => fs.existsSync(dir));
  if (roots.length === 0) {
    addError(progress, `Gemini CLI data folder not found: ${getGeminiDataPath()}`);
    return { report, progress, dayDetail: Object.create(null) };
  }
  const files = roots.flatMap((dir) => findFiles(dir, () => true, progress.errors)).filter(isChatFile);
  progress.projectsFound = new Set(files.map((f) => path.basename(path.dirname(path.dirname(f))))).size;
  onProgress?.(progress);

  const replies = new Map<string, Message>();

  /** One message record from either format. Replies with tokens are kept, the last version of each. */
  const take = (sessionId: string, value: unknown): void => {
    if (!value || typeof value !== 'object') return;
    const m = value as Record<string, unknown>;
    if (m.type !== 'gemini' || typeof m.id !== 'string' || !m.id || !m.tokens || typeof m.tokens !== 'object') return;
    const t = m.tokens as Record<string, unknown>;
    const input = tokenCount(t.input);
    const cached = Math.min(tokenCount(t.cached), input);
    const message: Message = {
      model: modelName(m.model),
      ts: plausibleTime(m.timestamp, nowMs),
      sessionId,
      input: input + tokenCount(t.tool),
      cached,
      output: tokenCount(t.output) + tokenCount(t.thoughts),
    };
    const key = `${sessionId}\u0000${m.id}`;
    if (replies.has(key)) progress.duplicatesSkipped++;
    replies.set(key, message);
  };

  const readOne = async (file: string, size: number): Promise<void> => {
    if (file.endsWith('.json')) {
      if (size > MAX_JSON_BYTES) {
        addError(progress, `Skipped a chat file over ${MAX_JSON_BYTES / (1024 * 1024)} MB: ${file}`);
        return;
      }
      const record = parseJsonLine<Record<string, unknown>>(fs.readFileSync(file, 'utf8'));
      if (!record || typeof record.sessionId !== 'string' || !Array.isArray(record.messages)) return;
      for (const message of record.messages) take(record.sessionId, message);
      return;
    }
    let sessionId: string | null = null;
    await forEachLine(
      file,
      size,
      (line) => {
        // Most lines are prompts, tool output and $set updates. Only a reply has "tokens".
        if (sessionId !== null && !line.includes('"tokens"')) return;
        const entry = parseJsonLine<Record<string, unknown>>(line);
        if (!entry || typeof entry !== 'object') return;
        if (sessionId === null) {
          // The first line names the session
          if (typeof entry.sessionId === 'string' && entry.sessionId) sessionId = entry.sessionId;
          else sessionId = file;
          if (typeof entry.id !== 'string') return;
        }
        const set = entry.$set as Record<string, unknown> | undefined;
        // An old full-history checkpoint
        if (set && Array.isArray(set.messages)) for (const message of set.messages) take(sessionId, message);
        if (entry.$patch === undefined) take(sessionId, entry);
      },
      () => addError(progress, `Skipped a line longer than ${MAX_LINE_CHARS / (1024 * 1024)} MB in: ${file}`),
    );
  };

  await readFiles(files, progress, onProgress, readOne);

  const counted: Reply[] = [];
  for (const m of replies.values()) {
    if (!window.contains(m.ts)) continue;
    counted.push({
      model: m.model,
      ts: m.ts,
      sessionId: m.sessionId,
      input: m.input - m.cached,
      output: m.output,
      cacheRead: m.cached,
      cacheWrite5m: 0,
      cacheWrite1h: 0,
      stopped: true,
    });
  }
  const dayDetail = aggregate(report, counted, progress);
  return { report, progress, dayDetail };
}
