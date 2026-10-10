import React, { useMemo } from 'react';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import { Info } from 'lucide-react';
import { UsageReport } from '../types';
import { analyzeUsagePattern } from '../services/analysisService';
import { withQuietDays } from '../services/dailyRows';
import { formatCount, formatDay } from '../services/format';
import { CHART_START_SIZE } from './chartSize';

interface UsagePatternPanelProps {
  data: UsageReport;
  /** Show the tip about Claude Code's live limits. Not useful for someone who only uses claude.ai. */
  showCliHint?: boolean;
}

/**
 * Plain facts about activity. No plan verdict: Anthropic does not publish the size of plan limits,
 * so any verdict from this data would be a guess.
 */
const PlanFitAnalyzer: React.FC<UsagePatternPanelProps> = ({ data, showCliHint = true }) => {
  const pattern = useMemo(() => analyzeUsagePattern(data), [data]);
  // Quiet days are drawn as zero, so the time axis has no gaps
  const dailyRows = useMemo(() => withQuietDays(data.usage.messages.by_day), [data]);

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold text-white">Usage pattern</h2>
        <p className="text-sm text-slate-200 mt-1">
          {data.provider === 'anthropic'
            ? "Plans have a 5-hour limit and a weekly limit, not a daily one. Anthropic doesn't publish their sizes, so this panel gives facts and no verdict."
            : 'Facts about when you used it. No verdict on limits: this panel only counts replies.'}
        </p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div className="bg-slate-900/50 rounded-xl p-4">
          <div className="text-xs text-slate-300">Active days</div>
          <div className="text-2xl font-bold text-white">{pattern.activeDays}</div>
          <div className="text-xs text-slate-300">of {pattern.periodDays} days</div>
        </div>
        <div className="bg-slate-900/50 rounded-xl p-4">
          <div className="text-xs text-slate-300">Busiest day</div>
          <div className="text-2xl font-bold text-white">{pattern.peakDay ? formatCount(pattern.peakDay.count) : '—'}</div>
          <div className="text-xs text-slate-300">{pattern.peakDay ? `replies on ${formatDay(pattern.peakDay.date)}` : 'no activity'}</div>
        </div>
        <div className="bg-slate-900/50 rounded-xl p-4">
          <div className="text-xs text-slate-300">Average per active day</div>
          <div className="text-2xl font-bold text-white">{formatCount(pattern.avgPerActiveDay)}</div>
          <div className="text-xs text-slate-300">replies</div>
        </div>
      </div>

      {data.usage.messages.by_day.length > 1 && (
        <div className="h-[220px] w-full" role="img" aria-label="Bar chart of replies per day">
          <ResponsiveContainer width="100%" height="100%" initialDimension={CHART_START_SIZE}>
            <BarChart data={dailyRows} accessibilityLayer={false}>
              <CartesianGrid strokeDasharray="3 3" stroke="#334155" vertical={false} />
              <XAxis dataKey="date" stroke="#cbd5e1" fontSize={11} tickFormatter={(d: string) => formatDay(d)} />
              <YAxis stroke="#cbd5e1" fontSize={11} allowDecimals={false} />
              <Tooltip
                contentStyle={{ backgroundColor: '#1e293b', borderColor: '#334155', color: '#f8fafc' }}
                labelFormatter={(key: string) => formatDay(key)}
                formatter={(value: number) => [formatCount(value), 'Replies']}
              />
              <Bar dataKey="count" fill="#c084fc" radius={[4, 4, 0, 0]} isAnimationActive={false} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}

      {showCliHint && (
        <div className="flex gap-3 bg-indigo-500/10 border border-indigo-500/30 rounded-xl p-4 text-sm text-slate-100">
          <Info className="w-5 h-5 text-indigo-200 shrink-0 mt-0.5" aria-hidden="true" />
          <p>
            Want to see your real limit? On Pro or Max, with Claude Code 2.1.243 or newer, set <code className="text-indigo-100">llm-usage-analyzer statusline</code> as your Claude Code status line (steps are in the README, under Live limits).
            It records your live 5-hour and weekly percentages. After a few days, <code className="text-indigo-100">llm-usage-analyzer limits --plan max5x</code> (use the plan you pay for) shows the downgrade check.
          </p>
        </div>
      )}
    </div>
  );
};

export default PlanFitAnalyzer;
