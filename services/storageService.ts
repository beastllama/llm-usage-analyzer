import { UsageReport, StoredReport } from '../types';
import { safeLocal } from './safeStorage';
import { isUsageReport } from './fileImport';
import { formatDate } from './format';

const HISTORY_KEY = 'llm_usage_history';
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
    typeof r.id === 'string' && typeof r.savedAt === 'string' && typeof r.name === 'string' &&
    isUsageReport(r.report),
  );
}

/** Reports saved in this browser. Storage that is blocked or full is never an error: the list is just empty. */
export const storageService = {
  getReports(): StoredReport[] {
    const raw = safeLocal.get(HISTORY_KEY);
    if (!raw) return [];
    try {
      const parsed: unknown = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed.filter(isStoredReport) : [];
    } catch {
      // Keep the unreadable copy so it is not silently overwritten on the next save
      safeLocal.set(`${HISTORY_KEY}_unreadable`, raw);
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

  clearHistory(): void {
    safeLocal.remove(HISTORY_KEY);
  },

  /** "Sep 1, 2026 to Sep 15, 2026". Two reports from the same month still get different names. */
  generateReportName(report: UsageReport): string {
    return `${formatDate(report.period.start)} to ${formatDate(report.period.end)}`;
  },

  /** A saved report that covers the same period, if there is one. */
  findDuplicateReport(report: UsageReport): StoredReport | undefined {
    return this.getReports().find((stored) =>
      stored.report.provider === report.provider &&
      stored.report.period.start === report.period.start &&
      stored.report.period.end === report.period.end,
    );
  },
};

export default storageService;
