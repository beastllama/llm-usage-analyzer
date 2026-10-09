import * as fs from 'fs';
import * as path from 'path';
import { historyDir } from './history.js';

/**
 * Live limit readings from Claude Code's status line (Pro and Max only).
 * Anthropic publishes the plan multipliers, but not the exact token caps.
 * So the downgrade check works in percentages of each plan's own window.
 */

export interface LimitSample {
  ts: number;          // unix ms
  five_hour: number;   // % of the current 5-hour window used, 0-100
  five_reset?: number; // unix seconds when that window resets
  seven_day?: number;  // % of the weekly limit used, 0-100
  session?: string;
}

/** Stay under this share of a plan's window. This is this tool's rule, not Anthropic's. */
export const HEADROOM = 0.8;

const SAMPLE_GAP_MS = 5 * 60 * 1000;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const KEEP_MS = 60 * 24 * 60 * 60 * 1000;

export function limitsFile(): string {
  return path.join(historyDir(), 'limits.jsonl');
}

const isPercent = (v: unknown): v is number =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 100;

/** Pull the rate-limit numbers out of the status-line JSON. Returns null when there is nothing usable. */
export function parseStatusLine(input: unknown): LimitSample | null {
  const obj = input as any;
  const five = obj?.rate_limits?.five_hour;
  if (!five || !isPercent(five.used_percentage)) return null;
  const seven = obj?.rate_limits?.seven_day;
  return {
    ts: Date.now(),
    five_hour: five.used_percentage,
    five_reset: typeof five.resets_at === 'number' ? five.resets_at : undefined,
    seven_day: seven && isPercent(seven.used_percentage) ? seven.used_percentage : undefined,
    session: typeof obj?.session_id === 'string' ? obj.session_id : undefined,
  };
}

/** Keep the file small: one sample every 5 minutes, or sooner when the 5-hour value moves 2+ points. */
export function shouldRecord(prev: LimitSample | null, next: LimitSample): boolean {
  if (!prev) return true;
  if (next.ts - prev.ts >= SAMPLE_GAP_MS) return true;
  return Math.abs(next.five_hour - prev.five_hour) >= 2;
}

export function readSamples(file = limitsFile()): LimitSample[] {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf-8');
  } catch {
    return [];
  }
  const samples: LimitSample[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const s = JSON.parse(line);
      if (isPercent(s.five_hour) && typeof s.ts === 'number') samples.push(s);
    } catch {
      // skip a damaged line
    }
  }
  return samples;
}

/** Append one sample. Trims old samples when the file grows past 2 MB. */
export function recordSample(sample: LimitSample, file = limitsFile()): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.appendFileSync(file, JSON.stringify(sample) + '\n', { mode: 0o600 });

  try {
    if (fs.statSync(file).size > MAX_FILE_BYTES) {
      const cutoff = Date.now() - KEEP_MS;
      const kept = readSamples(file).filter(s => s.ts >= cutoff);
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, kept.map(s => JSON.stringify(s) + '\n').join(''), { mode: 0o600 });
      fs.renameSync(tmp, file);
    }
  } catch {
    // Trimming is best effort. The new sample is already saved.
  }
}

export function lastSample(file = limitsFile()): LimitSample | null {
  const all = readSamples(file);
  return all.length ? all[all.length - 1] : null;
}

export interface PlanOption {
  plan: string;
  multiplier: number; // Pro's per-window allowance = 1, Max 5x = 5, Max 20x = 20
}

export interface DowngradeRow {
  plan: string;
  neededPercent: number; // share of this plan's window the same usage would need
  fits: boolean;
}

/**
 * Re-express the peak 5-hour usage on a plan with a different allowance.
 * Same work, measured against the other plan's window, scaled by the published multipliers.
 */
export function downgradeCheck(peakPercent: number, currentMultiplier: number, options: PlanOption[]): DowngradeRow[] {
  const proWindows = (peakPercent / 100) * currentMultiplier;
  return options.map(o => {
    const neededPercent = (proWindows / o.multiplier) * 100;
    return { plan: o.plan, neededPercent, fits: neededPercent <= HEADROOM * 100 };
  });
}
