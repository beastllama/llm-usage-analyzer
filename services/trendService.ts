import { StoredReport, TrendData, UsageTrend, UsageReport } from '../types';
import { costByModel, tokenCost } from './pricing';
import { spanDays } from './analysisService';

/** Cost of a report, summed by model at list prices. */
function calculateReportCost(report: UsageReport): number {
  return costByModel(report.usage.tokens.by_model).cost;
}

/** Month key (YYYY-MM) for a day key (YYYY-MM-DD). Day keys are already calendar dates, so no timezone shift. */
const monthOf = (dayKey: string) => dayKey.slice(0, 7);

/**
 * Group stored reports by the month of each day they cover.
 * A report that spans two months is counted in both, not dumped into its start month.
 */
export function groupReportsByMonth(reports: StoredReport[]): Map<string, StoredReport[]> {
  const grouped = new Map<string, StoredReport[]>();

  for (const stored of reports) {
    const months = new Set(stored.report.usage.messages.by_day.map(d => monthOf(d.date)));
    if (months.size === 0) months.add(monthOf(stored.report.period.start.slice(0, 10)));
    for (const monthKey of months) {
      if (!grouped.has(monthKey)) grouped.set(monthKey, []);
      grouped.get(monthKey)!.push(stored);
    }
  }

  return grouped;
}

/**
 * Monthly totals. Each report's cost is split across its days by token share,
 * so a report that spans two months is split between them.
 */
export function calculateMonthlyTrends(reports: StoredReport[]): TrendData[] {
  const months = new Map<string, TrendData & { reportIds: Set<string> }>();

  const bucket = (monthKey: string) => {
    if (!months.has(monthKey)) {
      months.set(monthKey, {
        period: monthKey,
        totalTokens: 0,
        totalCost: 0,
        inputTokens: 0,
        outputTokens: 0,
        messageCount: 0,
        sessionCount: 0,
        activeDays: 0,
        reportIds: new Set<string>(),
      });
    }
    return months.get(monthKey)!;
  };

  for (const stored of reports) {
    const { report } = stored;
    const reportTokens = report.usage.tokens.input + report.usage.tokens.output;
    const reportCost = calculateReportCost(report);

    for (const day of report.usage.messages.by_day) {
      const t = bucket(monthOf(day.date));
      const dayTokens = day.input + day.output;
      t.activeDays += day.count > 0 ? 1 : 0;
      t.inputTokens += day.input;
      t.outputTokens += day.output;
      t.totalTokens += dayTokens;
      t.messageCount += day.count;
      t.totalCost += reportTokens > 0 ? (dayTokens / reportTokens) * reportCost : 0;
      // Sessions are counted once per report per month, not once per day
      if (!t.reportIds.has(stored.id)) {
        t.reportIds.add(stored.id);
        t.sessionCount += report.usage.sessions.count;
      }
    }
  }

  return Array.from(months.values())
    .map(({ reportIds, ...trend }) => trend)
    .sort((a, b) => a.period.localeCompare(b.period));
}

/** A month counts as "full enough" to compare only when it has at least this many active days. */
const MIN_DAYS_TO_COMPARE = 20;

/**
 * Calculate usage trend analysis.
 * percentChange is null when the latest month is too short to compare fairly.
 */
export function analyzeUsageTrends(reports: StoredReport[]): UsageTrend | null {
  if (reports.length === 0) return null;

  const monthlyData = calculateMonthlyTrends(reports);
  if (monthlyData.length === 0) return null;

  let percentChange: number | null = null;
  if (monthlyData.length >= 2) {
    const current = monthlyData[monthlyData.length - 1];
    const previous = monthlyData[monthlyData.length - 2];
    if (previous.totalCost > 0 && current.activeDays >= MIN_DAYS_TO_COMPARE) {
      percentChange = ((current.totalCost - previous.totalCost) / previous.totalCost) * 100;
    }
  }

  // Average per calendar day across the reports' periods, so quiet days count
  const totalCost = monthlyData.reduce((acc, m) => acc + m.totalCost, 0);
  const totalDays = reports.reduce((acc, s) => acc + spanDays(s.report.period.start, s.report.period.end), 0);
  const avgDailyCost = totalDays > 0 ? totalCost / totalDays : 0;

  return {
    data: monthlyData,
    percentChange,
    avgDailyCost,
    projectedMonthlyCost: avgDailyCost * 30,
  };
}

/**
 * Get daily usage breakdown across all reports
 */
export function getDailyBreakdown(reports: StoredReport[]): Array<{
  date: string;
  tokens: number;
  cost: number;
  messages: number;
}> {
  const dayMap = new Map<string, { tokens: number; cost: number; messages: number }>();

  for (const stored of reports) {
    const report = stored.report;
    const reportTotalTokens = report.usage.tokens.input + report.usage.tokens.output;
    const reportCost = calculateReportCost(report);

    for (const day of report.usage.messages.by_day) {
      const existing = dayMap.get(day.date) || { tokens: 0, cost: 0, messages: 0 };
      const dayTokens = day.input + day.output;
      const dayCost = reportTotalTokens > 0 ? (dayTokens / reportTotalTokens) * reportCost : 0;

      dayMap.set(day.date, {
        tokens: existing.tokens + dayTokens,
        cost: existing.cost + dayCost,
        messages: existing.messages + day.count,
      });
    }
  }

  return Array.from(dayMap.entries())
    .map(([date, data]) => ({ date, ...data }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * Get usage heatmap by day of week
 */
export function getWeekdayHeatmap(reports: StoredReport[]): Array<{
  day: string;
  avgTokens: number;
  avgMessages: number;
}> {
  const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const dayStats = dayNames.map(() => ({ totalTokens: 0, totalMessages: 0, count: 0 }));

  for (const stored of reports) {
    for (const day of stored.report.usage.messages.by_day) {
      // Parse as a calendar date so the weekday does not shift with timezone
      const [y, m, d] = day.date.split('-').map(Number);
      const dayOfWeek = new Date(y, m - 1, d).getDay();

      dayStats[dayOfWeek].totalTokens += day.input + day.output;
      dayStats[dayOfWeek].totalMessages += day.count;
      dayStats[dayOfWeek].count++;
    }
  }

  return dayNames.map((name, i) => ({
    day: name,
    avgTokens: dayStats[i].count > 0 ? dayStats[i].totalTokens / dayStats[i].count : 0,
    avgMessages: dayStats[i].count > 0 ? dayStats[i].totalMessages / dayStats[i].count : 0,
  }));
}

/**
 * Calculate model usage distribution across all reports.
 * Uses a Map so model names like "__proto__" are safe keys.
 */
export function getModelDistribution(reports: StoredReport[]): Array<{
  model: string;
  tokens: number;
  cost: number;
  percentage: number;
}> {
  const modelStats = new Map<string, { input: number; output: number; cost: number }>();
  let totalTokens = 0;

  for (const stored of reports) {
    for (const [model, tokens] of Object.entries(stored.report.usage.tokens.by_model)) {
      const entry = modelStats.get(model) || { input: 0, output: 0, cost: 0 };
      entry.input += tokens.input;
      entry.output += tokens.output;
      entry.cost += tokenCost(model, tokens).cost;
      modelStats.set(model, entry);
      totalTokens += tokens.input + tokens.output;
    }
  }

  return Array.from(modelStats.entries())
    .map(([model, s]) => {
      const modelTokens = s.input + s.output;
      return {
        model: model.replace('claude-', '').replace('gpt-', ''),
        tokens: modelTokens,
        cost: s.cost,
        percentage: totalTokens > 0 ? (modelTokens / totalTokens) * 100 : 0,
      };
    })
    .sort((a, b) => b.tokens - a.tokens);
}

/**
 * Format month string for display
 */
export function formatMonth(period: string): string {
  const [year, month] = period.split('-');
  const date = new Date(parseInt(year), parseInt(month) - 1);
  return date.toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
}
