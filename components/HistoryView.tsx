import React, { useMemo, useEffect, useRef } from 'react';
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  BarChart, Bar, PieChart, Pie, Cell,
} from 'recharts';
import { TrendingUp, TrendingDown, Calendar, Coins, MessageSquare, Cpu, ArrowLeft } from 'lucide-react';
import { StoredReport } from '../types';
import {
  analyzeUsageTrends,
  getRecentDays,
  getWeekdayHeatmap,
  getModelDistribution,
  formatMonth,
  MIN_DAYS_TO_COMPARE,
} from '../services/trendService';
import { formatApproxUsd, formatAtLeastUsd, formatDay, formatTokenNumber, formatUsd, plural } from '../services/format';
import { CHART_START_SIZE } from './chartSize';

interface HistoryViewProps {
  reports: StoredReport[];
  onBack: () => void;
}

const COLORS = ['#818cf8', '#c084fc', '#f472b6', '#fb7185', '#fbbf24', '#34d399', '#22d3ee', '#a3a3a3'];
const TOOLTIP_STYLE = { backgroundColor: '#1e293b', border: '1px solid #334155', borderRadius: '8px' };

const HistoryView: React.FC<HistoryViewProps> = ({ reports, onBack }) => {
  const trends = useMemo(() => analyzeUsageTrends(reports), [reports]);
  const recentDays = useMemo(() => getRecentDays(reports, 30), [reports]);
  const weekdayData = useMemo(() => getWeekdayHeatmap(reports), [reports]);
  const modelData = useMemo(() => getModelDistribution(reports), [reports]);
  const headingRef = useRef<HTMLHeadingElement>(null);

  // Land on the heading, so a keyboard or screen-reader user starts at the top of the new screen
  useEffect(() => {
    window.scrollTo(0, 0);
    headingRef.current?.focus({ preventScroll: true });
  }, []);

  if (!trends || trends.data.length === 0) {
    return (
      <div className="max-w-4xl mx-auto py-12 px-4 text-center">
        <div className="bg-slate-800/40 rounded-2xl border border-white/10 p-12">
          <Calendar className="w-12 h-12 text-slate-300 mx-auto mb-4" aria-hidden="true" />
          <h1 ref={headingRef} tabIndex={-1} className="text-xl font-bold text-white mb-2 outline-none">No trend to show yet</h1>
          <p className="text-slate-200 mb-6">Trends need saved Claude Code reports with prices. A claude.ai chat export has none.</p>
          <button
            onClick={onBack}
            className="px-6 min-h-11 bg-indigo-500 hover:bg-indigo-400 text-white rounded-lg font-medium transition-colors"
          >
            Back
          </button>
        </div>
      </div>
    );
  }

  const latestMonth = trends.data[trends.data.length - 1];
  const change = trends.percentChange;
  const isGrowth = (change ?? 0) > 0;
  const monthly = trends.projectedMonthlyCost;
  const notPriced = monthly === 0 && trends.hasUnpriced;
  const minimum = trends.lowerBound;
  /** A cost figure for a card: "at least" (rounded down) when only a minimum is known. */
  const money = (n: number, exact = false) => (minimum ? `At least ${formatAtLeastUsd(n)}` : exact ? formatUsd(n) : formatApproxUsd(n));

  return (
    <div className="max-w-7xl mx-auto py-8 px-4">
      {/* Header */}
      <div className="flex items-center gap-4 mb-8">
        <button
          onClick={onBack}
          aria-label="Back"
          className="min-w-11 min-h-11 flex items-center justify-center rounded-full hover:bg-white/10 text-slate-200 hover:text-white transition-colors"
        >
          <ArrowLeft className="w-5 h-5" aria-hidden="true" />
        </button>
        <div>
          <h1 ref={headingRef} tabIndex={-1} className="text-2xl font-bold text-white outline-none">Trends</h1>
          <p className="text-slate-300 text-sm">
            Using {trends.reportsUsed} of {plural(reports.length, 'saved report')}.
            {trends.reportsUsed < reports.length ? ' Chat exports have no prices, and a report that overlaps a newer one is skipped, so no day counts twice.' : ''}
          </p>
        </div>
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-8">
        <div className="bg-slate-800/40 rounded-xl border border-white/10 p-5">
          <div className="flex items-center gap-2 text-slate-300 text-sm mb-2">
            <Coins className="w-4 h-4" aria-hidden="true" />
            Pay-as-you-go per month
          </div>
          <div className="text-2xl font-bold text-white">{notPriced ? 'Not priced' : money(monthly)}</div>
          <div className="text-xs text-slate-300 mt-1">
            {minimum
              ? 'A minimum at list prices: some replies were cut short in the log, or some usage has no known price, so the real cost is higher.'
              : 'An estimate at list prices, from your average day.'}
            {' '}Costs are spread across days by token count.
          </div>
        </div>

        <div className="bg-slate-800/40 rounded-xl border border-white/10 p-5">
          <div className="flex items-center gap-2 text-slate-300 text-sm mb-2">
            {change === null ? null : isGrowth
              ? <TrendingUp className="w-4 h-4 text-red-300" aria-hidden="true" />
              : <TrendingDown className="w-4 h-4 text-green-300" aria-hidden="true" />}
            Month over month
          </div>
          {change === null ? (
            <>
              <div className="text-2xl font-bold text-slate-300">—</div>
              <div className="text-xs text-slate-300 mt-1">
                {trends.data.length < 2
                  ? 'Needs two months of data.'
                  : `Compared only when both months have at least ${MIN_DAYS_TO_COMPARE} active days, and follow each other.`}
              </div>
            </>
          ) : (
            <>
              <div className={`text-2xl font-bold ${isGrowth ? 'text-red-300' : 'text-green-300'}`}>
                {isGrowth ? '+' : ''}{change.toFixed(1)}%
              </div>
              <div className="text-xs text-slate-300 mt-1">{minimum ? 'Minimum pay-as-you-go cost' : 'Pay-as-you-go cost'}, compared with the month before</div>
            </>
          )}
        </div>

        <div className="bg-slate-800/40 rounded-xl border border-white/10 p-5">
          <div className="flex items-center gap-2 text-slate-300 text-sm mb-2">
            <MessageSquare className="w-4 h-4" aria-hidden="true" />
            Average day
          </div>
          <div className="text-2xl font-bold text-white">{notPriced ? 'Not priced' : money(trends.avgDailyCost, true)}</div>
          <div className="text-xs text-slate-300 mt-1">Pay-as-you-go, across every calendar day</div>
        </div>

        <div className="bg-slate-800/40 rounded-xl border border-white/10 p-5">
          <div className="flex items-center gap-2 text-slate-300 text-sm mb-2">
            <Cpu className="w-4 h-4" aria-hidden="true" />
            Latest month
          </div>
          <div className="text-2xl font-bold text-white">{formatTokenNumber(latestMonth.totalTokens)}</div>
          <div className="text-xs text-slate-300 mt-1">tokens in {formatMonth(latestMonth.period)}</div>
        </div>
      </div>

      {/* Charts Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="bg-slate-800/40 rounded-xl border border-white/10 p-6">
          <h2 className="text-lg font-semibold text-white mb-4">Pay-as-you-go cost by month{minimum ? ' (a minimum)' : ''}</h2>
          <div className="h-64" role="img" aria-label="Line chart of the pay-as-you-go cost for each month">
            <ResponsiveContainer width="100%" height="100%" initialDimension={CHART_START_SIZE}>
              <LineChart data={trends.data.map((d) => ({ ...d, month: formatMonth(d.period) }))} accessibilityLayer={false}>
                <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
                <XAxis dataKey="month" stroke="#cbd5e1" fontSize={12} />
                <YAxis stroke="#cbd5e1" fontSize={12} tickFormatter={(v) => formatApproxUsd(v)} />
                <Tooltip
                  contentStyle={TOOLTIP_STYLE}
                  labelStyle={{ color: '#f1f5f9' }}
                  formatter={(value: number) => [formatUsd(value), minimum ? 'Cost (at least)' : 'Cost']}
                />
                <Line type="monotone" dataKey="totalCost" stroke="#818cf8" strokeWidth={3} dot={{ fill: '#818cf8', strokeWidth: 2 }} isAnimationActive={false} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </div>

        <div className="bg-slate-800/40 rounded-xl border border-white/10 p-6">
          <h2 className="text-lg font-semibold text-white mb-4">Tokens per day (the last 30 days)</h2>
          <div className="h-64" role="img" aria-label="Bar chart of tokens per day for the last 30 days">
            <ResponsiveContainer width="100%" height="100%" initialDimension={CHART_START_SIZE}>
              <BarChart data={recentDays} accessibilityLayer={false}>
                <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
                <XAxis dataKey="date" stroke="#cbd5e1" fontSize={10} tickFormatter={(d: string) => formatDay(d)} />
                <YAxis stroke="#cbd5e1" fontSize={12} tickFormatter={(v) => formatTokenNumber(v)} />
                <Tooltip
                  contentStyle={TOOLTIP_STYLE}
                  labelStyle={{ color: '#f1f5f9' }}
                  labelFormatter={(d: string) => formatDay(d)}
                  formatter={(value: number) => [formatTokenNumber(value), 'Tokens']}
                />
                <Bar dataKey="tokens" fill="#c084fc" radius={[4, 4, 0, 0]} isAnimationActive={false} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>

        <div className="bg-slate-800/40 rounded-xl border border-white/10 p-6">
          <h2 className="text-lg font-semibold text-white mb-4">Models</h2>
          <div className="flex flex-col sm:flex-row sm:items-center gap-4">
            <div className="h-56 w-full sm:w-1/2" role="img" aria-label={`Pie chart of tokens by model. ${modelData.slice(0, 5).map((m) => `${m.model} ${m.percentage.toFixed(0)}%`).join(', ')}`}>
              <ResponsiveContainer width="100%" height="100%" initialDimension={CHART_START_SIZE}>
                <PieChart accessibilityLayer={false}>
                  <Pie data={modelData} cx="50%" cy="50%" innerRadius={50} outerRadius={80} dataKey="tokens" paddingAngle={2} isAnimationActive={false}>
                    {modelData.map((entry, index) => (
                      <Cell key={entry.model} fill={COLORS[index % COLORS.length]} />
                    ))}
                  </Pie>
                  <Tooltip contentStyle={TOOLTIP_STYLE} formatter={(value: number) => `${formatTokenNumber(value)} tokens`} />
                </PieChart>
              </ResponsiveContainer>
            </div>
            <ul className="flex-1 space-y-2">
              {modelData.slice(0, 8).map((model, i) => (
                <li key={model.model} className="flex items-center gap-2">
                  <span className="w-3 h-3 rounded-full shrink-0" style={{ backgroundColor: COLORS[i % COLORS.length] }} aria-hidden="true" />
                  <span className="text-sm text-slate-100 truncate flex-1">{model.model}</span>
                  <span className="text-xs text-slate-300">{model.percentage.toFixed(1)}%</span>
                </li>
              ))}
            </ul>
          </div>
        </div>

        <div className="bg-slate-800/40 rounded-xl border border-white/10 p-6">
          <h2 className="text-lg font-semibold text-white mb-4">Average tokens by day of the week</h2>
          <div className="h-64" role="img" aria-label="Bar chart of average tokens for each day of the week">
            <ResponsiveContainer width="100%" height="100%" initialDimension={CHART_START_SIZE}>
              <BarChart data={weekdayData} accessibilityLayer={false}>
                <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
                <XAxis dataKey="day" stroke="#cbd5e1" fontSize={12} tickFormatter={(d) => d.slice(0, 3)} />
                <YAxis stroke="#cbd5e1" fontSize={12} tickFormatter={(v) => formatTokenNumber(v)} />
                <Tooltip
                  contentStyle={TOOLTIP_STYLE}
                  labelStyle={{ color: '#f1f5f9' }}
                  formatter={(value: number) => [formatTokenNumber(value), 'Average tokens']}
                />
                <Bar dataKey="avgTokens" fill="#a78bfa" radius={[4, 4, 0, 0]} isAnimationActive={false} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      </div>
    </div>
  );
};

export default HistoryView;
