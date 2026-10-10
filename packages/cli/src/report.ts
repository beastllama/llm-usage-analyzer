import * as fs from 'fs';
import * as path from 'path';
import type { ScanOptions, UsageReport } from './types.js';
import { scanClaudeUsage, getClaudeDataPath } from './parsers/claude.js';
import { localDayKey, type ParseProgress, type ScanResult } from './parsers/common.js';
import { loadHistoryChecked, saveHistory, addHistoryToReport, mergeForSave, currentTimeZone, sameZone, historyDir } from './history.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/** One local tool whose logs this command reads. */
export interface ToolReader {
  /** As people say it: "Claude Code". */
  tool: string;
  /** Short and stable, for file names: "claude". */
  key: string;
  /** The folder it reads. */
  dataPath: () => string;
  /** The setting (environment variable) the tool itself uses to keep its data somewhere else. */
  envVar: string;
  scan: (options: ScanOptions, onProgress?: (progress: ParseProgress) => void) => Promise<ScanResult>;
}

export const claudeReader: ToolReader = {
  tool: 'Claude Code',
  key: 'claude',
  dataPath: getClaudeDataPath,
  envVar: 'CLAUDE_CONFIG_DIR',
  scan: scanClaudeUsage,
};

/** Every tool, in the order they are shown. */
export const READERS: ToolReader[] = [claudeReader];

/** True when the tool's folder is there, so it has been used on this computer. */
export const readerHasData = (reader: ToolReader): boolean => fs.existsSync(reader.dataPath());

/** The tools that have been used on this computer. */
export const readersWithData = (): ToolReader[] => READERS.filter(readerHasData);

/**
 * Where a tool's saved days are kept. Claude Code's file keeps its old name, so history saved by earlier versions
 * is still found.
 */
export function historyFileFor(reader: ToolReader): string {
  return path.join(historyDir(), reader.key === 'claude' ? 'history.json' : `history-${reader.key}.json`);
}

export interface BuiltReport {
  reader: ToolReader;
  report: UsageReport;
  progress: ParseProgress;
  /** Days added from saved history (days the tool has already deleted). */
  historyDaysAdded: number;
  /** Set when the history file could not be written (the scan itself still worked). */
  historySaveError?: string;
  /** Set when the saved history could not be read in full. */
  historyWarning?: string;
}

/**
 * The one place that turns one tool's logs + its saved history into a report.
 * scan, analyze and serve all use it, so they cannot disagree.
 */
export async function buildReport(
  options: ScanOptions & { save?: boolean } = {},
  onProgress?: (progress: ParseProgress) => void,
  reader: ToolReader = claudeReader,
): Promise<BuiltReport> {
  const { report, progress, dayDetail } = await reader.scan(options, onProgress);
  const file = historyFileFor(reader);

  const hasDateFilter = Boolean(options.days || options.startDate || options.endDate);
  const useHistory = options.history !== false && !hasDateFilter;

  let historyDaysAdded = 0;
  let historySaveError: string | undefined;
  const loaded = loadHistoryChecked(file);
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
        saveHistory(mergeForSave(stored, complete, { sameZone: sameClock }), file, { unreadable: loaded.unreadable, timeZone: zone });
      } catch (err) {
        historySaveError = (err as Error).message;
      }
    }
  }

  return { reader, report, progress, historyDaysAdded, historySaveError, historyWarning };
}

/** A report for every tool that has been used on this computer, in the order of READERS. */
export async function buildAllReports(
  options: ScanOptions & { save?: boolean } = {},
  onProgress?: (reader: ToolReader, progress: ParseProgress) => void,
): Promise<BuiltReport[]> {
  const built: BuiltReport[] = [];
  for (const reader of readersWithData()) {
    built.push(await buildReport(options, onProgress && ((p) => onProgress(reader, p)), reader));
  }
  return built;
}

/** The format of a file or answer that holds one report per tool. The dashboard reads the same format. */
export const BUNDLE_FORMAT = 'llm-usage-bundle';

export interface UsageBundle {
  format: typeof BUNDLE_FORMAT;
  version: 1;
  reports: UsageReport[];
}

export const toBundle = (reports: UsageReport[]): UsageBundle => ({ format: BUNDLE_FORMAT, version: 1, reports });
