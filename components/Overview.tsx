import React, { useMemo } from 'react';
import { ChevronRight } from 'lucide-react';
import { UsageReport } from '../types';
import type { MonthlyComparison } from '../services/analysisService';
import type { Verdict } from '../services/estimate';
import type { ProductId } from '../services/products';
import { overviewRows, overviewTotals } from '../services/overview';
import { formatApproxUsd, formatAtLeastUsd, formatUsd } from '../services/format';

interface OverviewProps {
  reports: UsageReport[];
  /** The plan picked for each product, if any. Without one, the product's usual plan is assumed. */
  chosenPlans: Partial<Record<ProductId, string>>;
  /** Which report the answer below shows. */
  active: number;
  onShow: (index: number) => void;
}

const SHORT: Record<Verdict, { text: string; tone: string }> = {
  keep: { text: 'Your plan costs less', tone: 'text-green-200' },
  switch: { text: 'Pay-as-you-go costs less', tone: 'text-amber-100' },
  tie: { text: 'About the same', tone: 'text-slate-100' },
  unknown: { text: "Can't say yet", tone: 'text-amber-100' },
};

const payg = (cmp: MonthlyComparison): string =>
  cmp.lowerBound ? `at least ${formatAtLeastUsd(cmp.apiCostMonthly)}` : `about ${formatApproxUsd(cmp.apiCostMonthly)}`;

/**
 * All the tools at once: each one's plan against its pay-as-you-go estimate, and the totals (services/overview.ts).
 * Each row opens that tool's full answer below.
 */
const Overview: React.FC<OverviewProps> = ({ reports, chosenPlans, active, onShow }) => {
  const rows = useMemo(() => overviewRows(reports, chosenPlans), [reports, chosenPlans]);
  const totals = useMemo(() => overviewTotals(rows), [rows]);

  return (
    <section aria-labelledby="overview-title" className="bg-slate-800/60 border border-slate-700 rounded-2xl p-6 md:p-8 space-y-4">
      <div>
        <p className="text-xs uppercase tracking-wide text-slate-300">All your tools</p>
        <h2 id="overview-title" className="text-2xl md:text-3xl font-bold text-white mt-1">{totals.headline}</h2>
        {totals.lines.map((line) => <p key={line} className="text-slate-200 mt-2">{line}</p>)}
        {totals.anyAssumed && (
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
                        : `${row.cmp.planKey}${row.assumed ? ' (assumed)' : ''} ${formatUsd(row.cmp.planPrice)}/mo` +
                          (row.cmp.onDemandMonthly > 0 ? ` + ${formatApproxUsd(row.cmp.onDemandMonthly)} on demand` : '') +
                          ` · pay-as-you-go ${payg(row.cmp)}/mo`}
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
