// The overview of several tools: one row per tool, and the totals. Kept apart from the screen so it can be tested.
import type { UsageReport } from '../types';
import { calculateAnalysis, type MonthlyComparison } from './analysisService';
import { decide, type Verdict } from './estimate';
import { ESTIMATED_MODEL } from './fileImport';
import { productOf, type ProductId } from './products';
import { formatApproxUsd, formatAtLeastUsd, formatUsd, plain } from './format';

export interface OverviewRow {
  tool: string;
  cmp: MonthlyComparison;
  /** False when this report cannot be compared, with the reason in `why`. */
  comparable: boolean;
  why: string;
  /** The plan is the product's usual one, because the person has not picked theirs. */
  assumed: boolean;
}

export function overviewRows(reports: UsageReport[], chosenPlans: Partial<Record<ProductId, string>>): OverviewRow[] {
  return reports.map((report) => {
    const product = productOf(report);
    const cmp = calculateAnalysis(report, product ? chosenPlans[product.id] : undefined);
    const tokens = report.usage.tokens.input + report.usage.tokens.output;
    const activityOnly = Object.keys(report.usage.tokens.by_model).includes(ESTIMATED_MODEL);
    const why = tokens === 0 ? 'No usage yet'
      : activityOnly ? 'Activity only, no prices'
        : !product ? 'No plan to compare with'
          : 'No prices for these models';
    return {
      tool: plain(report.tool ?? product?.tools ?? 'Unknown tool'),
      cmp,
      comparable: cmp.canJudge && tokens > 0,
      why,
      assumed: !(product && chosenPlans[product.id]),
    };
  });
}

export interface OverviewTotals {
  /** One sentence for the top of the page. */
  headline: string;
  /** Plain sentences with the numbers. */
  lines: string[];
  /** True when a plan in the totals was assumed, not picked. */
  anyAssumed: boolean;
}

const OVERALL: Record<Verdict, string> = {
  keep: 'Your plans cost less than pay-as-you-go.',
  switch: 'Pay-as-you-go would cost less than your plans.',
  tie: 'Your plans and pay-as-you-go cost about the same.',
  unknown: "We can't say yet.",
};

const andList = (names: string[]) => (names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}` : names[0] ?? '');
const money = (n: number, minimum: boolean) => (minimum ? `at least ${formatAtLeastUsd(n)}` : `about ${formatApproxUsd(n)}`);

/**
 * The headline and totals. Plans are bought one by one, so one verdict for all of them is only given when every
 * plan gets the same one: otherwise a plan that doesn't pay off would hide behind one that does.
 * A plan is counted once even when two tools share it. On-demand charges count as paid.
 */
export function overviewTotals(rows: OverviewRow[]): OverviewTotals {
  const compared = rows.filter((r) => r.comparable && !r.cmp.payAsYouGo);
  const paygRows = rows.filter((r) => r.comparable && r.cmp.payAsYouGo);
  const lines: string[] = [];

  const seen = new Set<string>();
  let plans = 0;
  for (const r of compared) {
    if (seen.has(r.cmp.product.id)) continue;
    seen.add(r.cmp.product.id);
    plans += r.cmp.planPrice;
  }
  const onDemand = compared.reduce((sum, r) => sum + r.cmp.onDemandMonthly, 0);
  const api = compared.reduce((sum, r) => sum + r.cmp.apiCostMonthly, 0);
  const apiMinimum = compared.some((r) => r.cmp.lowerBound);
  const anyAssumed = compared.some((r) => r.assumed);
  const payg = paygRows.reduce((sum, r) => sum + r.cmp.apiCostMonthly, 0);
  const paygMinimum = paygRows.some((r) => r.cmp.lowerBound);
  const paygTools = paygRows.map((r) => r.tool);

  let headline: string;
  if (compared.length > 0) {
    const verdicts = new Set(compared.map((r) => r.cmp.verdict));
    headline = verdicts.size === 1 ? OVERALL[compared[0].cmp.verdict] : 'The answer is different for each tool. See below.';
    const planWords = seen.size === 1 ? 'Your plan' : `Your ${seen.size} plans`;
    lines.push(
      `${planWords}${anyAssumed ? ' (some assumed)' : ''} cost ${formatUsd(plans)} a month` +
      (onDemand > 0 ? `, plus about ${formatApproxUsd(onDemand)} billed on demand. ` : '. ') +
      `At pay-as-you-go list prices, the same use would cost ${money(api, apiMinimum)} a month.`,
    );
  } else if (paygTools.length > 0) {
    headline = `${andList(paygTools)} ${paygTools.length === 1 ? 'is' : 'are'} pay-as-you-go.`;
  } else {
    headline = 'Nothing to compare yet.';
  }

  if (paygTools.length > 0) {
    lines.push(`${andList(paygTools)} ${paygTools.length === 1 ? 'is' : 'are'} pay-as-you-go: ${money(payg, paygMinimum)} a month at list prices.`);
    if (compared.length > 0) {
      const minimum = paygMinimum || compared.some((r) => r.cmp.onDemandUnknown);
      lines.push(`All together, ${minimum ? 'at least' : 'about'} ${minimum ? formatAtLeastUsd(plans + onDemand + payg) : formatApproxUsd(plans + onDemand + payg)} a month.`);
    }
  }
  return { headline, lines, anyAssumed };
}
