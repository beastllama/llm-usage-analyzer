import React, { useMemo } from 'react';
import { ChevronRight } from 'lucide-react';
import { UsageReport } from '../types';
import { calculateAnalysis, type MonthlyComparison } from '../services/analysisService';
import { decide, type Verdict } from '../services/estimate';
import { ESTIMATED_MODEL } from '../services/fileImport';
import { productOf, type ProductId } from '../services/products';
import { formatApproxUsd, formatAtLeastUsd, formatUsd, plain } from '../services/format';

interface OverviewProps {
  reports: UsageReport[];
  /** The plan picked for each product, if any. Without one, the product's usual plan is assumed. */
  chosenPlans: Partial<Record<ProductId, string>>;
  /** Which report the answer below shows. */
  active: number;
  onShow: (index: number) => void;
}

interface Row {
  tool: string;
  cmp: MonthlyComparison;
  /** False when this report cannot be compared with a plan, with the reason in `why`. */
  comparable: boolean;
  why: string;
  assumed: boolean;
}

const SHORT: Record<Verdict, { text: string; tone: string }> = {
  keep: { text: 'Your plan costs less', tone: 'text-green-200' },
  switch: { text: 'Pay-as-you-go costs less', tone: 'text-amber-100' },
  tie: { text: 'About the same', tone: 'text-slate-100' },
  unknown: { text: "Can't say yet", tone: 'text-amber-100' },
};

const OVERALL: Record<Verdict, string> = {
  keep: 'Overall, your plans cost less than pay-as-you-go.',
  switch: 'Overall, pay-as-you-go would cost less than your plans.',
  tie: 'Overall, your plans and pay-as-you-go cost about the same.',
  unknown: "Overall, we can't say yet.",
};

const payg = (cmp: MonthlyComparison): string =>
  cmp.lowerBound ? `at least ${formatAtLeastUsd(cmp.apiCostMonthly)}` : `about ${formatApproxUsd(cmp.apiCostMonthly)}`;

/**
 * All the tools at once: each one's plan against its pay-as-you-go estimate, and the totals. Each row opens that
 * tool's full answer below. The totals are plain sums; a plan is counted once even when two tools share it.
 */
const Overview: React.FC<OverviewProps> = ({ reports, chosenPlans, active, onShow }) => {
  const rows: Row[] = useMemo(() => reports.map((report) => {
    const product = productOf(report);
    const cmp = calculateAnalysis(report, product ? chosenPlans[product.id] : undefined);
    const tokens = report.usage.tokens.input + report.usage.tokens.output;
    const activityOnly = Object.keys(report.usage.tokens.by_model).includes(ESTIMATED_MODEL);
    const why = tokens === 0 ? 'No usage yet'
      : activityOnly ? 'Activity only, no prices'
        : !product ? 'No plan to compare with'
          : "No prices for these models";
    return {
      tool: plain(report.tool ?? product?.tools ?? 'Unknown tool'),
      cmp,
      comparable: cmp.canJudge && tokens > 0,
      why,
      assumed: !(product && chosenPlans[product.id]),
    };
  }), [reports, chosenPlans]);

  const totals = useMemo(() => {
    // Tools covered by a plan are compared with it. Pay-as-you-go tools have no plan: their estimate is what they cost.
    const compared = rows.filter((r) => r.comparable && !r.cmp.payAsYouGo);
    const paygRows = rows.filter((r) => r.comparable && r.cmp.payAsYouGo);
    const payg = paygRows.reduce((sum, r) => sum + r.cmp.apiCostMonthly, 0);
    const paygMinimum = paygRows.some((r) => r.cmp.lowerBound);
    const seen = new Set<string>();
    let plans = 0;
    for (const r of compared) {
      if (seen.has(r.cmp.product.id)) continue;
      seen.add(r.cmp.product.id);
      plans += r.cmp.planPrice;
    }
    const api = compared.reduce((sum, r) => sum + r.cmp.apiCostMonthly, 0);
    const lowerBound = compared.some((r) => r.cmp.lowerBound);
    return {
      count: seen.size, plans, api, lowerBound, verdict: decide(plans, api, lowerBound), any: compared.length > 0,
      payg, paygMinimum, paygTools: paygRows.map((r) => r.tool),
    };
  }, [rows]);

  return (
    <section aria-labelledby="overview-title" className="bg-slate-800/60 border border-slate-700 rounded-2xl p-6 md:p-8 space-y-4">
      <div>
        <p className="text-xs uppercase tracking-wide text-slate-300">All your tools</p>
        <h2 id="overview-title" className="text-2xl md:text-3xl font-bold text-white mt-1">
          {totals.any ? OVERALL[totals.verdict] : totals.paygTools.length > 0 ? 'Your tools are pay-as-you-go.' : 'Nothing to compare yet.'}
        </h2>
        {totals.any && (
          <p className="text-slate-200 mt-2">
            You pay {formatUsd(totals.plans)} a month for {totals.count === 1 ? 'your plan' : `your ${totals.count} plans`}.
            {' '}At pay-as-you-go list prices, the same use would cost {totals.lowerBound ? `at least ${formatAtLeastUsd(totals.api)}` : `about ${formatApproxUsd(totals.api)}`} a month.
          </p>
        )}
        {totals.paygTools.length > 0 && (
          <p className="text-slate-200 mt-2">
            {totals.paygTools.join(' and ')} {totals.paygTools.length === 1 ? 'is' : 'are'} pay-as-you-go: {totals.paygMinimum ? `at least ${formatAtLeastUsd(totals.payg)}` : `about ${formatApproxUsd(totals.payg)}`} a month at list prices.
            {totals.any && ` All together, about ${formatApproxUsd(totals.plans + totals.payg)} a month${totals.paygMinimum ? ' or more' : ''}.`}
          </p>
        )}
        {rows.some((r) => r.comparable && r.assumed && !r.cmp.payAsYouGo) && (
          <p className="text-sm text-slate-300 mt-2">Where you haven't picked your plan, we assumed the usual one. Open a tool below to pick yours.</p>
        )}
      </div>

      <ul className="space-y-2">
        {rows.map((row, i) => {
          const short = !row.comparable ? { text: row.why, tone: 'text-slate-300' }
            : row.cmp.payAsYouGo ? { text: 'Pay-as-you-go', tone: 'text-slate-100' }
              : SHORT[row.cmp.verdict];
          const isActive = i === active;
          return (
            <li key={`${row.tool}-${i}`}>
              <button
                onClick={() => onShow(i)}
                aria-pressed={isActive}
                className={`w-full text-left rounded-xl px-4 py-3 min-h-11 border flex flex-wrap items-center gap-x-4 gap-y-1 ${
                  isActive ? 'border-indigo-300 bg-indigo-500/15' : 'border-white/10 bg-slate-900/40 hover:border-white/30'
                }`}
              >
                <span className="flex-1 min-w-[10rem]">
                  <span className="block text-white font-medium">{row.tool}</span>
                  {row.comparable && (
                    <span className="block text-sm text-slate-300">
                      {row.cmp.payAsYouGo
                        ? `No plan · ${payg(row.cmp)}/mo at list prices`
                        : `${row.cmp.planKey}${row.assumed ? ' (assumed)' : ''} ${formatUsd(row.cmp.planPrice)}/mo · pay-as-you-go ${payg(row.cmp)}/mo`}
                    </span>
                  )}
                </span>
                <span className={`text-sm font-medium ${short.tone}`}>{short.text}</span>
                <ChevronRight className="w-4 h-4 text-slate-300 shrink-0" aria-hidden="true" />
                <span className="sr-only">{isActive ? '(shown below)' : '(show below)'}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
};

export default Overview;
