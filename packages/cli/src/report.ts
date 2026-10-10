import type { ScanOptions, UsageReport } from './types.js';
import { scanClaudeUsage, localDayKey, ParseProgress, DayDetail } from './parsers/claude.js';
import { loadHistoryChecked, saveHistory, addHistoryToReport, mergeForSave, currentTimeZone, sameZone } from './history.js';

const DAY_MS = 24 * 60 * 60 * 1000;

export interface BuiltReport {
  report: UsageReport;
  progress: ParseProgress;
  /** Days added from saved history (days Claude Code has already deleted). */
  historyDaysAdded: number;
  /** Set when the history file could not be written (the scan itself still worked). */
  historySaveError?: string;
  /** Set when the saved history could not be read in full. */
  historyWarning?: string;
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
  let historySaveError: string | undefined;
  const loaded = loadHistoryChecked();
  const { days: stored, warning: historyWarning } = loaded;
  // Saved days kept on a clock in another time zone have other day boundaries than this scan
  const zone = currentTimeZone();
  const sameClock = sameZone(loaded.timeZone, zone);

  if (useHistory) {
    historyDaysAdded = addHistoryToReport(report, dayDetail, stored, { sameZone: sameClock });
  }

  if (options.save) {
    // Only complete days are saved. Today is still open, and a --days window starts partway through its first day.
    const incomplete = new Set<string>([localDayKey(new Date())]);
    if (options.days) incomplete.add(localDayKey(new Date(Date.now() - options.days * DAY_MS)));
    const complete = Object.fromEntries(Object.entries(dayDetail).filter(([day]) => !incomplete.has(day)));
    if (!loaded.safeToSave) {
      // The file is there but could not be read, so saving would replace it with a new one
      historySaveError = 'the saved history could not be read, so it was left as it is';
    } else {
      try {
        saveHistory(mergeForSave(stored, complete, { sameZone: sameClock }), undefined, { unreadable: loaded.unreadable, timeZone: zone });
      } catch (err) {
        historySaveError = (err as Error).message;
      }
    }
  }

  return { report, progress, historyDaysAdded, historySaveError, historyWarning };
}
