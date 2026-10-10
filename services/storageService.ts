import { UsageReport, StoredReport } from '../types';
import { safeLocal } from './safeStorage';
import { isUsageReport } from './fileImport';
import { formatDate } from './format';

const HISTORY_KEY = 'llm_usage_history';
const UNREADABLE_KEY = `${HISTORY_KEY}_unreadable`;
const MAX_HISTORY_ITEMS = 50;

let counter = 0;
function generateId(): string {
  counter++;
  return `${Date.now()}-${counter}-${Math.random().toString(36).substring(2, 9)}`;
}

/** A saved entry the app can open. Anything else (damaged, from an older version, hand-edited) is left out. */
function isStoredReport(value: unknown): value is StoredReport {
  const r = value as Partial<StoredReport> | null;
  return Boolean(
    r && typeof r === 'object' &&
    typeof r.id === 'string' && typeof r.savedAt === 'string' && !Number.isNaN(Date.parse(r.savedAt)) &&
    typeof r.name === 'string' && isUsageReport(r.report),
  );
}

/** Reports saved in this browser. Storage that is blocked or full is never an error: the list is just empty. */
export const storageService = {
  getReports(): StoredReport[] {
    const raw = safeLocal.get(HISTORY_KEY);
    if (!raw) return [];
    try {
      const parsed: unknown = JSON.parse(raw);
      // The list is capped when it is saved, but a hand-edited or older list may be longer
      return Array.isArray(parsed) ? parsed.filter(isStoredReport).slice(0, MAX_HISTORY_ITEMS) : [];
    } catch {
      // Keep the unreadable copy so it is not silently overwritten on the next save
      safeLocal.set(UNREADABLE_KEY, raw);
      safeLocal.remove(HISTORY_KEY);
      return [];
    }
  },

  /** Returns false when the browser would not keep the list (storage full or blocked). */
  setReports(reports: StoredReport[]): boolean {
    return safeLocal.set(HISTORY_KEY, JSON.stringify(reports));
  },

  /** Save a report at the front of the list. Returns null when it could not be kept. */
  saveReport(report: UsageReport, name?: string): StoredReport | null {
    const stored: StoredReport = {
      id: generateId(),
      report,
      savedAt: new Date().toISOString(),
      name: name || this.generateReportName(report),
    };
    const history = [stored, ...this.getReports()].slice(0, MAX_HISTORY_ITEMS);
    return this.setReports(history) ? stored : null;
  },

  /** Replace the data of a saved report (keeps its id and name) and move it to the front. */
  updateReportData(id: string, report: UsageReport): boolean {
    const history = this.getReports();
    const existing = history.find((r) => r.id === id);
    if (!existing) return false;
    existing.report = report;
    existing.savedAt = new Date().toISOString();
    return this.setReports([existing, ...history.filter((r) => r.id !== id)]);
  },

  deleteReport(id: string): boolean {
    return this.setReports(this.getReports().filter((r) => r.id !== id));
  },

  /**
   * Put deleted reports back (for Undo). Only these reports are added, to the list as it is now, so anything saved
   * since the delete stays. Reports already in the list are not added twice.
   */
  restoreReports(entries: StoredReport[]): boolean {
    const current = this.getReports();
    const have = new Set(current.map((r) => r.id));
    const merged = [...current, ...entries.filter((e) => !have.has(e.id))]
      .sort((a, b) => b.savedAt.localeCompare(a.savedAt))
      .slice(0, MAX_HISTORY_ITEMS);
    return this.setReports(merged);
  },

  /** Remove every saved report, and the damaged copy that was set aside earlier. */
  clearHistory(): void {
    safeLocal.remove(HISTORY_KEY);
    safeLocal.remove(UNREADABLE_KEY);
  },

  /** "Codex CLI · Sep 1, 2026 to Sep 15, 2026". Two reports from the same month still get different names. */
  generateReportName(report: UsageReport): string {
    const dates = `${formatDate(report.period.start)} to ${formatDate(report.period.end)}`;
    return report.tool ? `${report.tool} · ${dates}` : dates;
  },

  /** A saved report that covers the same period, if there is one. */
  findDuplicateReport(report: UsageReport): StoredReport | undefined {
    return this.getReports().find((stored) =>
      stored.report.provider === report.provider &&
      stored.report.product === report.product &&
      stored.report.tool === report.tool &&
      stored.report.period.start === report.period.start &&
      stored.report.period.end === report.period.end,
    );
  },
};

export default storageService;
