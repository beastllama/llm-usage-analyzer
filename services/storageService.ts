import { UsageReport, StoredReport, UserSettings } from '../types';

const STORAGE_KEYS = {
  USAGE_HISTORY: 'llm_usage_history',
  USER_SETTINGS: 'llm_user_settings',
  STORAGE_VERSION: 'llm_storage_version',
} as const;

const CURRENT_VERSION = 1;
const MAX_HISTORY_ITEMS = 50;

// Generate a unique ID
function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
}

// Check and migrate storage if needed
function migrateStorageIfNeeded(): void {
  const version = localStorage.getItem(STORAGE_KEYS.STORAGE_VERSION);
  if (!version || parseInt(version) < CURRENT_VERSION) {
    // Future migrations would go here
    localStorage.setItem(STORAGE_KEYS.STORAGE_VERSION, CURRENT_VERSION.toString());
  }
}

export const storageService = {
  /**
   * Initialize storage (call on app mount)
   */
  init(): void {
    migrateStorageIfNeeded();
  },

  /**
   * Save a usage report to history
   */
  saveReport(report: UsageReport, name?: string): StoredReport {
    const history = this.getReports();

    const stored: StoredReport = {
      id: generateId(),
      report,
      savedAt: new Date().toISOString(),
      name: name || this.generateReportName(report),
    };

    // Add to beginning (most recent first)
    history.unshift(stored);

    // Limit history size
    if (history.length > MAX_HISTORY_ITEMS) {
      history.pop();
    }

    localStorage.setItem(STORAGE_KEYS.USAGE_HISTORY, JSON.stringify(history));
    return stored;
  },

  /**
   * Get all saved reports
   */
  getReports(): StoredReport[] {
    let data: string | null = null;
    try {
      data = localStorage.getItem(STORAGE_KEYS.USAGE_HISTORY);
      const parsed = data ? JSON.parse(data) : [];
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      // Keep the unreadable copy so it is not silently overwritten on the next save
      if (data) {
        try {
          localStorage.setItem(`${STORAGE_KEYS.USAGE_HISTORY}_unreadable_${Date.now()}`, data);
          localStorage.removeItem(STORAGE_KEYS.USAGE_HISTORY);
        } catch {
          // Storage unavailable. Nothing more to do.
        }
      }
      console.error('Saved reports could not be read. A backup copy was kept.');
      return [];
    }
  },

  /**
   * Replace the data of an existing saved report (keeps its id and name)
   */
  updateReportData(id: string, report: UsageReport): StoredReport | undefined {
    const history = this.getReports();
    const existing = history.find(r => r.id === id);
    if (!existing) return undefined;
    existing.report = report;
    existing.savedAt = new Date().toISOString();
    localStorage.setItem(STORAGE_KEYS.USAGE_HISTORY, JSON.stringify(history));
    return existing;
  },

  /**
   * Get a single report by ID
   */
  getReportById(id: string): StoredReport | undefined {
    const history = this.getReports();
    return history.find(r => r.id === id);
  },

  /**
   * Delete a report by ID
   */
  deleteReport(id: string): void {
    const history = this.getReports().filter(r => r.id !== id);
    localStorage.setItem(STORAGE_KEYS.USAGE_HISTORY, JSON.stringify(history));
  },

  /**
   * Update a report's name
   */
  renameReport(id: string, name: string): void {
    const history = this.getReports();
    const report = history.find(r => r.id === id);
    if (report) {
      report.name = name;
      localStorage.setItem(STORAGE_KEYS.USAGE_HISTORY, JSON.stringify(history));
    }
  },

  /**
   * Clear all history
   */
  clearHistory(): void {
    localStorage.removeItem(STORAGE_KEYS.USAGE_HISTORY);
  },

  /**
   * Get user settings
   */
  getSettings(): UserSettings {
    try {
      const data = localStorage.getItem(STORAGE_KEYS.USER_SETTINGS);
      return data ? JSON.parse(data) : {};
    } catch {
      return {};
    }
  },

  /**
   * Save user settings
   */
  saveSettings(settings: UserSettings): void {
    localStorage.setItem(STORAGE_KEYS.USER_SETTINGS, JSON.stringify(settings));
  },

  /**
   * Update specific setting
   */
  updateSetting<K extends keyof UserSettings>(key: K, value: UserSettings[K]): void {
    const settings = this.getSettings();
    settings[key] = value;
    this.saveSettings(settings);
  },

  /**
   * Generate a descriptive name for a report
   */
  generateReportName(report: UsageReport): string {
    const provider = report.provider.charAt(0).toUpperCase() + report.provider.slice(1);
    const startDate = new Date(report.period.start);
    const month = startDate.toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
    return `${provider} - ${month}`;
  },

  /**
   * Check if a similar report already exists (same provider + period)
   */
  findDuplicateReport(report: UsageReport): StoredReport | undefined {
    const history = this.getReports();
    return history.find(stored =>
      stored.report.provider === report.provider &&
      stored.report.period.start === report.period.start &&
      stored.report.period.end === report.period.end
    );
  },

  /**
   * Export all data as JSON (for backup)
   */
  exportAll(): string {
    return JSON.stringify({
      version: CURRENT_VERSION,
      exportedAt: new Date().toISOString(),
      history: this.getReports(),
      settings: this.getSettings(),
    }, null, 2);
  },

  /**
   * Import data from JSON backup
   */
  importAll(jsonData: string): { success: boolean; imported: number; error?: string } {
    try {
      const data = JSON.parse(jsonData);

      if (!data.history || !Array.isArray(data.history)) {
        return { success: false, imported: 0, error: 'Invalid backup format' };
      }

      // Merge with existing (avoid duplicates)
      const existing = this.getReports();
      const existingIds = new Set(existing.map(r => r.id));

      let imported = 0;
      for (const report of data.history) {
        if (!existingIds.has(report.id)) {
          existing.push(report);
          imported++;
        }
      }

      // Sort by date and trim
      existing.sort((a, b) => new Date(b.savedAt).getTime() - new Date(a.savedAt).getTime());
      const trimmed = existing.slice(0, MAX_HISTORY_ITEMS);

      localStorage.setItem(STORAGE_KEYS.USAGE_HISTORY, JSON.stringify(trimmed));

      // Import settings if present
      if (data.settings) {
        const currentSettings = this.getSettings();
        this.saveSettings({ ...currentSettings, ...data.settings });
      }

      return { success: true, imported };
    } catch (e) {
      return { success: false, imported: 0, error: 'Failed to parse backup file' };
    }
  },

  /**
   * Get storage usage info
   */
  getStorageInfo(): { usedBytes: number; itemCount: number } {
    const history = localStorage.getItem(STORAGE_KEYS.USAGE_HISTORY) || '';
    const settings = localStorage.getItem(STORAGE_KEYS.USER_SETTINGS) || '';

    return {
      usedBytes: (history.length + settings.length) * 2, // UTF-16
      itemCount: this.getReports().length,
    };
  },
};

export default storageService;
