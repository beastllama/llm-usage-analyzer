import type { ScanOptions, UsageReport } from './types.js';
import { scanClaudeUsage, ParseProgress, DayDetail } from './parsers/claude.js';
import { loadHistory, saveHistory, addHistoryToReport } from './history.js';

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
    // Days from this scan are complete, so they replace what was saved before
    saveHistory({ ...stored, ...dayDetail });
  }

  return { report, progress, historyDaysAdded };
}
