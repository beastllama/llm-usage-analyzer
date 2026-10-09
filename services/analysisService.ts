import { UsageReport } from "../types";
import { PLANS, PlanKey, costByModel } from "./pricing";

const DAY_MS = 24 * 60 * 60 * 1000;

/** Calendar days covered by the report, inclusive. Never less than 1. */
export function spanDays(start: string, end: string): number {
  const s = new Date(start).getTime();
  const e = new Date(end).getTime();
  if (Number.isNaN(s) || Number.isNaN(e)) return 1;
  return Math.max(1, Math.floor((e - s) / DAY_MS) + 1);
}

export interface MonthlyComparison {
  planKey: PlanKey;
  planPrice: number;
  /** List-price API cost for the report period. */
  apiCostPeriod: number;
  /** The same cost scaled to 30 days. */
  apiCostMonthly: number;
  periodDays: number;
  /** True when the period is under a week, so the monthly figure is a rough guess. */
  lowConfidence: boolean;
  unpricedTokens: number;
  unpricedModels: string[];
  /** False when no token could be priced, so there is nothing to compare. */
  canJudge: boolean;
  /** "keep": the plan is cheaper than pay-as-you-go. "switch": pay-as-you-go is cheaper. */
  verdict: "keep" | "switch";
  /** Absolute monthly difference between plan price and pay-as-you-go estimate. */
  difference: number;
}

export function calculateAnalysis(report: UsageReport, planKey: PlanKey): MonthlyComparison {
  const { cost, unpricedTokens, unpricedModels } = costByModel(report.usage.tokens.by_model);
  const periodDays = spanDays(report.period.start, report.period.end);
  const apiCostMonthly = cost * (30 / periodDays);
  const planPrice = PLANS[planKey].price;
  const pricedTokens = Object.values(report.usage.tokens.by_model).reduce(
    (sum, t) => sum + t.input + t.output + (t.cache_read || 0) + (t.cache_write || 0),
    0,
  ) - unpricedTokens;

  return {
    planKey,
    planPrice,
    apiCostPeriod: cost,
    apiCostMonthly,
    periodDays,
    lowConfidence: periodDays < 7,
    unpricedTokens,
    unpricedModels,
    canJudge: pricedTokens > 0,
    verdict: planPrice <= apiCostMonthly ? "keep" : "switch",
    difference: Math.abs(planPrice - apiCostMonthly),
  };
}

export interface UsagePattern {
  periodDays: number;
  activeDays: number;
  totalReplies: number;
  avgPerActiveDay: number;
  peakDay: { date: string; count: number } | null;
}

/** Plain usage facts. Anthropic publishes no daily cap, so this makes no plan verdict. */
export function analyzeUsagePattern(report: UsageReport): UsagePattern {
  const days = report.usage.messages.by_day;
  const active = days.filter(d => d.count > 0);
  const totalReplies = active.reduce((sum, d) => sum + d.count, 0);
  const peak = active.reduce<{ date: string; count: number } | null>(
    (best, d) => (!best || d.count > best.count ? { date: d.date, count: d.count } : best),
    null,
  );
  return {
    periodDays: spanDays(report.period.start, report.period.end),
    activeDays: active.length,
    totalReplies,
    avgPerActiveDay: active.length ? totalReplies / active.length : 0,
    peakDay: peak,
  };
}

export const formatTokenNumber = (num: number): string => {
  if (num >= 1_000_000) {
    return (num / 1_000_000).toFixed(1) + 'M';
  }
  if (num >= 1_000) {
    return (num / 1_000).toFixed(1) + 'k';
  }
  return num.toString();
};

export const formatUsd = (num: number): string => `$${num.toFixed(2)}`;
