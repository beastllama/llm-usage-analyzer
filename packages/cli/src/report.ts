import type { ScanOptions, UsageReport } from './types.js';
import { scanClaudeUsage, localDayKey, ParseProgress, DayDetail } from './parsers/claude.js';
import { loadHistory, saveHistory, addHistoryToReport, mergeForSave } from './history.js';

const DAY_MS = 24 * 60 * 60 * 1000;

export interface BuiltReport {
  report: UsageReport;
  progress: ParseProgress;
  /** Days added from saved history (days Claude Code has already deleted). */
  historyDaysAdded: number;
}

/**
 * The one place that turns transcripts + saved history into a report.
 * scan, analyze and serve all use it, so they cannot disagree.
 */
export async function buildReport(
  options: ScanOptions & { save?: boolean } = {},
  onProgress?: (progress: ParseProgress) => void,
): Promise<BuiltReport> {
  const { report, progress, dayDetail } = await scanClaudeUsage(options, onProgress);

  const hasDateFilter = Boolean(options.days || options.startDate || options.endDate);
  const useHistory = options.history !== false && !hasDateFilter;

  let historyDaysAdded = 0;
  const stored: Record<string, DayDetail> = loadHistory();

  if (useHistory) {
    historyDaysAdded = addHistoryToReport(report, dayDetail, stored);
  }

  if (options.save) {
    // Only complete days are saved. Today is still open, and a --days window starts partway through its first day.
    const incomplete = new Set<string>([localDayKey(new Date())]);
    if (options.days) incomplete.add(localDayKey(new Date(Date.now() - options.days * DAY_MS)));
    const complete = Object.fromEntries(Object.entries(dayDetail).filter(([day]) => !incomplete.has(day)));
    saveHistory(mergeForSave(stored, complete));
  }

  return { report, progress, historyDaysAdded };
}
