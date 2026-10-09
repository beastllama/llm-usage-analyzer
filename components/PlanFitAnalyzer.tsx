import React, { useMemo } from 'react';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import { Info } from 'lucide-react';
import { UsageReport } from '../types';
import { analyzeUsagePattern } from '../services/analysisService';

interface UsagePatternPanelProps {
  data: UsageReport;
}

/**
 * Plain facts about activity. No plan verdict: Anthropic does not publish a daily cap,
 * so any verdict from this data would be a guess.
 */
const PlanFitAnalyzer: React.FC<UsagePatternPanelProps> = ({ data }) => {
  const pattern = useMemo(() => analyzeUsagePattern(data), [data]);

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-lg font-semibold text-white">Usage pattern</h3>
        <p className="text-sm text-slate-400 mt-1">
          Just the facts from your logs. Anthropic does not publish a daily limit, so this panel makes no plan verdict.
        </p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div className="bg-slate-900/50 rounded-xl p-4">
          <div className="text-xs text-slate-500">Active days</div>
          <div className="text-2xl font-bold text-white">{pattern.activeDays}</div>
          <div className="text-xs text-slate-500">of {pattern.periodDays} days</div>
        </div>
        <div className="bg-slate-900/50 rounded-xl p-4">
          <div className="text-xs text-slate-500">Busiest day</div>
          <div className="text-2xl font-bold text-white">{pattern.peakDay ? pattern.peakDay.count : '—'}</div>
          <div className="text-xs text-slate-500">{pattern.peakDay ? `replies on ${pattern.peakDay.date}` : 'no activity'}</div>
        </div>
        <div className="bg-slate-900/50 rounded-xl p-4">
          <div className="text-xs text-slate-500">Average per active day</div>
          <div className="text-2xl font-bold text-white">{Math.round(pattern.avgPerActiveDay)}</div>
          <div className="text-xs text-slate-500">replies</div>
        </div>
      </div>

      <div className="h-[220px] w-full">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data.usage.messages.by_day}>
            <CartesianGrid strokeDasharray="3 3" stroke="#334155" vertical={false} />
            <XAxis dataKey="date" stroke="#94a3b8" fontSize={11} tickFormatter={(d: string) => d.slice(5)} />
            <YAxis stroke="#94a3b8" fontSize={11} allowDecimals={false} />
            <Tooltip
              contentStyle={{ backgroundColor: '#1e293b', borderColor: '#334155', color: '#f8fafc' }}
              formatter={(value: number) => [value, 'Replies']}
            />
            <Bar dataKey="count" fill="#8b5cf6" radius={[4, 4, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </div>

      <div className="flex gap-3 bg-indigo-500/10 border border-indigo-500/20 rounded-xl p-4 text-sm text-slate-300">
        <Info className="w-5 h-5 text-indigo-300 flex-shrink-0 mt-0.5" />
        <p>
          Want to see your real limit? On Pro or Max, run <code className="text-indigo-200">llm-usage statusline</code> once.
          It records your live 5-hour and weekly percentages, then <code className="text-indigo-200">llm-usage limits</code> shows the downgrade check.
        </p>
      </div>
    </div>
  );
};

export default PlanFitAnalyzer;
