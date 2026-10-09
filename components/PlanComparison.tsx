import React, { useMemo } from 'react';
import { X, Check } from 'lucide-react';
import { UsageReport } from '../types';
import { PLANS, PLAN_KEYS } from '../services/pricing';
import { calculateAnalysis } from '../services/analysisService';
import { describeCaveats } from '../services/answer';
import { formatAtLeastUsd, formatUsd } from '../services/format';

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
  const rows = useMemo(() => PLAN_KEYS.map((key) => calculateAnalysis(data, key)), [data]);
  const first = rows[0];
  const apiMonthly = first?.apiCostMonthly ?? 0;
  const minimum = first?.lowerBound ?? false;
  const caveats = first ? describeCaveats(first) : [];

  return (
    // No landmark of its own: the panel around it (in AnalysisDashboard) is the named region, so a screen reader hears one name
    <div className="bg-slate-800/40 rounded-2xl border border-white/10 p-6 space-y-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 id="compare-title" className="text-xl font-bold text-white">Compare plans</h2>
          <p className="text-sm text-slate-200 mt-1">
            Pay-as-you-go would cost {minimum ? 'at least ' : 'about '}
            <span className="text-white font-semibold">{minimum ? formatAtLeastUsd(apiMonthly) : formatUsd(apiMonthly)}/mo</span> at list prices.
          </p>
          {caveats.map((c) => <p key={c} className="text-sm text-amber-100 mt-1">{c}</p>)}
        </div>
        {onClose && (
          <button
            onClick={onClose}
            aria-label="Close plan comparison"
            className="min-w-11 min-h-11 flex items-center justify-center rounded-full hover:bg-white/10 text-slate-200 hover:text-white transition-colors"
          >
            <X className="w-5 h-5" aria-hidden="true" />
          </button>
        )}
      </div>

      <ul className="space-y-2">
        {rows.map((row) => {
          const isSelected = row.planKey === selectedPlan;
          const gap = minimum ? formatAtLeastUsd(row.difference) : formatUsd(row.difference);
          const [text, tone] =
            row.verdict === 'keep' ? [`${minimum ? 'At least ' : ''}${gap} less than pay-as-you-go`, 'text-green-200'] :
            row.verdict === 'tie' ? ['About the same as pay-as-you-go', 'text-slate-100'] :
            row.verdict === 'unknown' ? ["Can't say yet", 'text-amber-100'] :
            [`${gap} more than pay-as-you-go`, 'text-amber-100'];
          return (
            <li key={row.planKey}>
              <button
                onClick={() => onSelect(row.planKey)}
                aria-pressed={isSelected}
                className={`w-full text-left rounded-xl px-4 py-3 min-h-11 border transition-colors flex flex-wrap items-center justify-between gap-2 ${
                  isSelected ? 'border-indigo-300 bg-indigo-500/15' : 'border-white/10 bg-slate-900/40 hover:border-white/30'
                }`}
              >
                <span className="text-white font-medium flex items-center gap-2">
                  {isSelected && <Check className="w-4 h-4 text-indigo-200" aria-hidden="true" />}
                  {row.planKey} <span className="text-slate-300 font-normal">{formatUsd(row.planPrice)}/mo</span>
                  {isSelected && <span className="text-xs text-indigo-200">(your plan)</span>}
                </span>
                <span className={`text-sm ${tone}`}>{text}</span>
              </button>
            </li>
          );
        })}
      </ul>

      <p className="text-sm text-slate-300">
        Price only. Plans also differ in how much you can use (Pro 1x, Max 5x, Max 20x per 5-hour session). Anthropic doesn't publish exact limits.
      </p>
    </div>
  );
};

export default PlanComparison;
