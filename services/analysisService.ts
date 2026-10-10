import { UsageReport } from "../types";
import { costByModel } from "./pricing";
import { PRODUCTS, productOf, planOrDefault, type Product } from "./products";
import { decide, estimateQuality, type EstimateQuality, type Verdict } from "./estimate";

const DAY_MS = 24 * 60 * 60 * 1000;

/** Calendar days covered by the report, inclusive. Never less than 1. */
/**
 * Calendar days covered, inclusive, on the user's clock.
 * Counts days, not hours, so 20:00 on day 1 to 08:00 on day 9 is 9 days.
 */
export function spanDays(start: string, end: string): number {
  const s = new Date(start);
  const e = new Date(end);
  if (Number.isNaN(s.getTime()) || Number.isNaN(e.getTime())) return 1;
  const a = Date.UTC(s.getFullYear(), s.getMonth(), s.getDate());
  const b = Date.UTC(e.getFullYear(), e.getMonth(), e.getDate());
  return Math.max(1, Math.round((b - a) / DAY_MS) + 1);
}

export interface MonthlyComparison {
  /** The product the report counts against. Reports from a product with no plans list are compared with nothing (canJudge false). */
  product: Product;
  /** The plan compared with, by name ("Claude Pro"). Empty when the product has no plan (it is pay-as-you-go). */
  planKey: string;
  /** True when the tool is already billed at API prices, so there is no plan to compare with. */
  payAsYouGo: boolean;
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
  /** See Verdict in estimate.ts. */
  verdict: Verdict;
  /** True when the pay-as-you-go figure is a minimum (cut-short replies or unpriced models). */
  lowerBound: boolean;
  quality: EstimateQuality;
  /** Absolute monthly difference between what was paid (plan plus on-demand) and the pay-as-you-go estimate. */
  difference: number;
  /** On-demand charges beyond the plan that the tool's export shows (Cursor), scaled to 30 days. 0 when none. */
  onDemandMonthly: number;
  /** True when some on-demand use has no cost in the export, so what was paid is higher than shown. */
  onDemandUnknown: boolean;
  /** Plan price plus on-demand charges, per month: what the use really cost on the plan. */
  paidMonthly: number;
}

export function calculateAnalysis(report: UsageReport, planName?: string): MonthlyComparison {
  const { cost, unpricedTokens, unpricedModels } = costByModel(report.usage.tokens.by_model);
  const periodDays = spanDays(report.period.start, report.period.end);
  const apiCostMonthly = cost * (30 / periodDays);
  const known = productOf(report);
  const product = known ?? PRODUCTS.claude;
  // A report from no known product is compared with no plan
  const plan = known ? planOrDefault(known, planName) : null;
  const planPrice = plan?.price ?? 0;
  const quality = estimateQuality(report);
  const onDemand = report.usage.on_demand;
  const onDemandMonthly = (onDemand?.usd ?? 0) * (30 / periodDays);
  const onDemandUnknown = (onDemand?.rows_without_cost ?? 0) > 0;
  const paidMonthly = planPrice + onDemandMonthly;
  let verdict = decide(paidMonthly, apiCostMonthly, quality.lowerBound);
  // Part of what was paid is not known, so the plan cannot be shown to be the cheaper choice
  if (onDemandUnknown && verdict !== 'switch') verdict = 'unknown';

  return {
    product,
    planKey: plan?.name ?? '',
    payAsYouGo: product.payAsYouGo === true,
    planPrice,
    apiCostPeriod: cost,
    apiCostMonthly,
    periodDays,
    lowConfidence: periodDays < 7,
    unpricedTokens,
    unpricedModels,
    // A report from no known product has no plans to compare with
    canJudge: known !== null && quality.pricedTokens > 0,
    verdict,
    lowerBound: quality.lowerBound,
    quality,
    difference: Math.abs(paidMonthly - apiCostMonthly),
    onDemandMonthly,
    onDemandUnknown,
    paidMonthly,
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

// Formatting lives in format.ts. These names stay available here for the screens that already import them.
export { formatTokenNumber, formatUsd } from "./format";
