import React, { useMemo } from 'react';
import { X } from 'lucide-react';
import { UsageReport } from '../types';
import { PLANS, PLAN_KEYS } from '../services/pricing';
import { calculateAnalysis, formatUsd } from '../services/analysisService';

interface PlanComparisonProps {
  data: UsageReport;
  selectedPlan: keyof typeof PLANS;
  onSelect: (plan: keyof typeof PLANS) => void;
  onClose?: () => void;
}

/**
 * Price-only comparison: each Claude plan against pay-as-you-go at list prices.
 * It does not judge whether a plan's usage limits would be hit, because those limits are not published.
 */
const PlanComparison: React.FC<PlanComparisonProps> = ({ data, selectedPlan, onSelect, onClose }) => {
  const rows = useMemo(() => PLAN_KEYS.map(key => calculateAnalysis(data, key)), [data]);
  const apiMonthly = rows[0]?.apiCostMonthly ?? 0;
  const lowConfidence = rows[0]?.lowConfidence ?? false;

  return (
    <section className="bg-slate-800/40 rounded-2xl border border-white/5 p-6 space-y-5" aria-labelledby="compare-title">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 id="compare-title" className="text-xl font-bold text-white">Compare plans</h2>
          <p className="text-sm text-slate-400 mt-1">
            Pay-as-you-go would cost about <span className="text-white font-semibold">{formatUsd(apiMonthly)}/mo</span> at list prices.
          </p>
          {lowConfidence && (
            <p className="text-xs text-amber-300 mt-1">Based on under a week of data, so treat this as a rough guess.</p>
          )}
        </div>
        {onClose && (
          <button
            onClick={onClose}
            aria-label="Close plan comparison"
            className="p-2 rounded-full hover:bg-white/5 text-slate-400 hover:text-white transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        )}
      </div>

      <ul className="space-y-2">
        {rows.map(row => {
          const cheaper = row.verdict === 'keep';
          const isSelected = row.planKey === selectedPlan;
          return (
            <li key={row.planKey}>
              <button
                onClick={() => onSelect(row.planKey)}
                aria-pressed={isSelected}
                className={`w-full text-left rounded-xl px-4 py-3 border transition-colors flex flex-wrap items-center justify-between gap-2 ${
                  isSelected ? 'border-indigo-500/60 bg-indigo-500/10' : 'border-white/5 bg-slate-900/40 hover:border-white/15'
                }`}
              >
                <span className="text-white font-medium">
                  {row.planKey} <span className="text-slate-400 font-normal">{formatUsd(row.planPrice)}/mo</span>
                  {isSelected && <span className="ml-2 text-xs text-indigo-300">(your plan)</span>}
                </span>
                <span className={`text-sm ${cheaper ? 'text-green-300' : 'text-amber-300'}`}>
                  {cheaper
                    ? `${formatUsd(row.difference)} less than pay-as-you-go`
                    : `${formatUsd(row.difference)} more than pay-as-you-go`}
                </span>
              </button>
            </li>
          );
        })}
      </ul>

      <p className="text-xs text-slate-500">
        Price only. Plans also differ in usage allowance per 5-hour window (Pro 1x, Max 5x, Max 20x). Anthropic does not publish the exact limits.
      </p>
    </section>
  );
};

export default PlanComparison;
