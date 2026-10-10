import { StoredReport, TrendData, UsageTrend, UsageReport } from '../types';
import { costByModel, tokenCost } from './pricing';
import { spanDays } from './analysisService';
import { estimateQuality } from './estimate';
import { calendarDays, parseDay, shiftDay, shortModelName } from './format';
import { productOf, type ProductId } from './products';

/** Cost of a report, summed by model at list prices. */
function calculateReportCost(report: UsageReport): number {
  return costByModel(report.usage.tokens.by_model).cost;
}

/** Month key (YYYY-MM) for a day key (YYYY-MM-DD). Day keys are already calendar dates, so no timezone shift. */
const monthOf = (dayKey: string) => dayKey.slice(0, 7);
const monthIndex = (monthKey: string) => {
  const [year, month] = monthKey.split('-').map(Number);
  return year * 12 + (month - 1);
};

/**
 * Saved uploads often cover the same days (a cumulative scan uploaded twice).
 * Newest first, keep a report only if none of its days is already counted.
 * So no day is ever counted twice. An older report that shares a day with a newer one is left out.
 */
export function pickNonOverlapping(reports: StoredReport[]): StoredReport[] {
  const newestFirst = [...reports].sort((a, b) => b.savedAt.localeCompare(a.savedAt));
  const covered = new Set<string>();
  const picked: StoredReport[] = [];
  for (const stored of newestFirst) {
    const days = stored.report.usage.messages.by_day.map(d => d.date);
    if (days.some(d => covered.has(d))) continue;
    days.forEach(d => covered.add(d));
    picked.push(stored);
  }
  return picked;
}

/** True when some of the report's usage has a price. A claude.ai chat export has none, so it cannot show a cost trend. */
export const hasPricedUsage = (stored: StoredReport): boolean => estimateQuality(stored.report).pricedTokens > 0;

const productId = (stored: StoredReport): ProductId | null => productOf(stored.report)?.id ?? null;

/** The products that have saved reports with prices, the one with the most reports first. */
export function trendProducts(all: StoredReport[]): ProductId[] {
  const counts = new Map<ProductId, number>();
  for (const stored of all.filter(hasPricedUsage)) {
    const id = productId(stored);
    if (id) counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);
}

/**
 * The saved reports that Trends uses: one product's reports (two tools can cover the same days, and both count),
 * only reports with priced usage, and no report that overlaps a newer one of the same product.
 * (A chat export and a Claude Code report can cover the same days. Only the Claude Code one has prices.)
 * Without a product, the product with the most saved reports is used.
 */
export function trendReports(all: StoredReport[], product?: ProductId): StoredReport[] {
  const id = product ?? trendProducts(all)[0];
  return pickNonOverlapping(all.filter((s) => hasPricedUsage(s) && productId(s) === id));
}

/**
 * Monthly totals. Each report's cost is split across its days by token share,
 * so a report that spans two months is split between them.
 */
export function calculateMonthlyTrends(allReports: StoredReport[], product?: ProductId): TrendData[] {
  const reports = trendReports(allReports, product);
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

/**
 * A month is compared with the one before only when both have at least this many active days.
 * A month with fewer is probably unfinished (or only partly saved), and a comparison would be unfair.
 */
export const MIN_DAYS_TO_COMPARE = 20;

/**
 * Calculate usage trend analysis.
 * percentChange is null unless the latest month and the month right before it both have enough days to compare fairly.
 */
export function analyzeUsageTrends(allReports: StoredReport[], product?: ProductId): UsageTrend | null {
  const reports = trendReports(allReports, product);
  if (reports.length === 0) return null;

  const monthlyData = calculateMonthlyTrends(reports, product);
  if (monthlyData.length === 0) return null;

  let percentChange: number | null = null;
  if (monthlyData.length >= 2) {
    const current = monthlyData[monthlyData.length - 1];
    const previous = monthlyData[monthlyData.length - 2];
    const adjacent = monthIndex(current.period) - monthIndex(previous.period) === 1;
    if (adjacent && previous.totalCost > 0 && current.activeDays >= MIN_DAYS_TO_COMPARE && previous.activeDays >= MIN_DAYS_TO_COMPARE) {
      percentChange = ((current.totalCost - previous.totalCost) / previous.totalCost) * 100;
    }
  }

  // Average per calendar day across the reports' periods, so quiet days count
  const totalCost = monthlyData.reduce((acc, m) => acc + m.totalCost, 0);
  const totalDays = reports.reduce((acc, s) => acc + spanDays(s.report.period.start, s.report.period.end), 0);
  const avgDailyCost = totalDays > 0 ? totalCost / totalDays : 0;

  const unpricedTokens = reports.reduce((acc, s) => acc + costByModel(s.report.usage.tokens.by_model).unpricedTokens, 0);

  return {
    data: monthlyData,
    percentChange,
    avgDailyCost,
    projectedMonthlyCost: avgDailyCost * 30,
    reportsUsed: reports.length,
    hasUnpriced: unpricedTokens > 0,
    lowerBound: reports.some((s) => estimateQuality(s.report).lowerBound),
  };
}

/**
 * Get daily usage breakdown across all reports
 */
export function getDailyBreakdown(allReports: StoredReport[], product?: ProductId): Array<{
  date: string;
  tokens: number;
  cost: number;
  messages: number;
}> {
  const reports = trendReports(allReports, product);

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
 * The last `count` calendar days, ending on the latest day that has data. Quiet days are there as zero,
 * so a chart of "the last 30 days" really covers 30 days and not the last 30 days with activity.
 */
export function getRecentDays(allReports: StoredReport[], count = 30, product?: ProductId): ReturnType<typeof getDailyBreakdown> {
  const rows = getDailyBreakdown(allReports, product);
  if (rows.length === 0) return [];
  const end = rows[rows.length - 1].date;
  // Never reach back past the first day with data: before that, nothing is known, which is not the same as nothing happened
  const start = [shiftDay(end, -(count - 1)), rows[0].date].sort().pop() as string;
  const byDate = new Map(rows.map((r) => [r.date, r]));
  return calendarDays(start, end).map(
    (date) => byDate.get(date) ?? { date, tokens: 0, cost: 0, messages: 0 },
  );
}

/**
 * Get usage heatmap by day of week
 */
export function getWeekdayHeatmap(allReports: StoredReport[], product?: ProductId): Array<{
  day: string;
  avgTokens: number;
  avgMessages: number;
}> {
  const reports = trendReports(allReports, product);

  const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const dayStats = dayNames.map(() => ({ totalTokens: 0, totalMessages: 0, count: 0 }));

  for (const stored of reports) {
    for (const day of stored.report.usage.messages.by_day) {
      // Parse as a calendar date so the weekday does not shift with timezone
      const dayOfWeek = parseDay(day.date).getDay();
      if (!dayStats[dayOfWeek]) continue;

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
export function getModelDistribution(allReports: StoredReport[], product?: ProductId): Array<{
  model: string;
  tokens: number;
  cost: number;
  percentage: number;
}> {
  const reports = trendReports(allReports, product);

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
        model: shortModelName(model),
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
