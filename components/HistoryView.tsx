import React, { useMemo } from 'react';
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  BarChart,
  Bar,
  PieChart,
  Pie,
  Cell,
} from 'recharts';
import { TrendingUp, TrendingDown, Calendar, Coins, MessageSquare, Cpu, ArrowLeft } from 'lucide-react';
import { StoredReport } from '../types';
import {
  analyzeUsageTrends,
  getDailyBreakdown,
  getWeekdayHeatmap,
  getModelDistribution,
  formatMonth,
} from '../services/trendService';

interface HistoryViewProps {
  reports: StoredReport[];
  onBack: () => void;
}

const COLORS = ['#6366f1', '#8b5cf6', '#a855f7', '#d946ef', '#ec4899', '#f43f5e'];

const HistoryView: React.FC<HistoryViewProps> = ({ reports, onBack }) => {
  const trends = useMemo(() => analyzeUsageTrends(reports), [reports]);
  const dailyData = useMemo(() => getDailyBreakdown(reports), [reports]);
  const weekdayData = useMemo(() => getWeekdayHeatmap(reports), [reports]);
  const modelData = useMemo(() => getModelDistribution(reports), [reports]);

  if (!trends || trends.data.length === 0) {
    return (
      <div className="max-w-4xl mx-auto py-12 px-4 text-center">
        <div className="bg-slate-800/40 rounded-2xl border border-white/5 p-12">
          <Calendar className="w-12 h-12 text-slate-500 mx-auto mb-4" />
          <h2 className="text-xl font-bold text-white mb-2">No Historical Data Yet</h2>
          <p className="text-slate-400 mb-6">
            Upload more usage reports to see trends over time.
          </p>
          <button
            onClick={onBack}
            className="px-6 py-2 bg-indigo-500 hover:bg-indigo-400 text-white rounded-lg font-medium transition-colors"
          >
            Go Back
          </button>
        </div>
      </div>
    );
  }

  const latestMonth = trends.data[trends.data.length - 1];
  const change = trends.percentChange;
  const isGrowth = (change ?? 0) > 0;

  return (
    <div className="max-w-7xl mx-auto py-8 px-4">
      {/* Header */}
      <div className="flex items-center gap-4 mb-8">
        <button
          onClick={onBack}
          aria-label="Back"
          className="p-2 rounded-full hover:bg-white/5 text-slate-400 hover:text-white transition-colors"
        >
          <ArrowLeft className="w-5 h-5" aria-hidden="true" />
        </button>
        <div>
          <h1 className="text-2xl font-bold text-white">Usage History</h1>
          <p className="text-slate-400 text-sm">
            Trends from {reports.length} saved report{reports.length !== 1 ? 's' : ''}
          </p>
        </div>
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-8">
        <div className="bg-slate-800/40 rounded-xl border border-white/5 p-5">
          <div className="flex items-center gap-2 text-slate-400 text-sm mb-2">
            <Coins className="w-4 h-4" aria-hidden="true" />
            Pay-as-you-go / month
          </div>
          <div className="text-2xl font-bold text-white">
            ${trends.projectedMonthlyCost.toFixed(2)}
          </div>
          <div className="text-xs text-slate-500 mt-1">Estimate at list prices, from average daily use</div>
        </div>

        <div className="bg-slate-800/40 rounded-xl border border-white/5 p-5">
          <div className="flex items-center gap-2 text-slate-400 text-sm mb-2">
            {change === null ? null : isGrowth
              ? <TrendingUp className="w-4 h-4 text-red-400" aria-hidden="true" />
              : <TrendingDown className="w-4 h-4 text-green-400" aria-hidden="true" />}
            Month over month
          </div>
          {change === null ? (
            <>
              <div className="text-2xl font-bold text-slate-400">—</div>
              <div className="text-xs text-slate-500 mt-1">Not enough data in the latest month yet (needs 20 active days)</div>
            </>
          ) : (
            <>
              <div className={`text-2xl font-bold ${isGrowth ? 'text-red-400' : 'text-green-400'}`}>
                {isGrowth ? '+' : ''}{change.toFixed(1)}%
              </div>
              <div className="text-xs text-slate-500 mt-1">Pay-as-you-go cost vs previous month</div>
            </>
          )}
        </div>

        <div className="bg-slate-800/40 rounded-xl border border-white/5 p-5">
          <div className="flex items-center gap-2 text-slate-400 text-sm mb-2">
            <MessageSquare className="w-4 h-4" aria-hidden="true" />
            Avg per day
          </div>
          <div className="text-2xl font-bold text-white">
            ${trends.avgDailyCost.toFixed(2)}
          </div>
          <div className="text-xs text-slate-500 mt-1">Pay-as-you-go, across all calendar days</div>
        </div>

        <div className="bg-slate-800/40 rounded-xl border border-white/5 p-5">
          <div className="flex items-center gap-2 text-slate-400 text-sm mb-2">
            <Cpu className="w-4 h-4" />
            Latest Month Tokens
          </div>
          <div className="text-2xl font-bold text-white">
            {(latestMonth.totalTokens / 1000).toFixed(0)}K
          </div>
          <div className="text-xs text-slate-500 mt-1">{formatMonth(latestMonth.period)}</div>
        </div>
      </div>

      {/* Charts Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Monthly Cost Trend */}
        <div className="bg-slate-800/40 rounded-xl border border-white/5 p-6">
          <h3 className="text-lg font-semibold text-white mb-4">Pay-as-you-go cost by month</h3>
          <div className="h-64">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={trends.data.map(d => ({ ...d, month: formatMonth(d.period) }))}>
                <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
                <XAxis dataKey="month" stroke="#94a3b8" fontSize={12} />
                <YAxis stroke="#94a3b8" fontSize={12} tickFormatter={(v) => `$${v}`} />
                <Tooltip
                  contentStyle={{ backgroundColor: '#1e293b', border: '1px solid #334155', borderRadius: '8px' }}
                  labelStyle={{ color: '#f1f5f9' }}
                  formatter={(value: number) => [`$${value.toFixed(2)}`, 'Cost']}
                />
                <Line
                  type="monotone"
                  dataKey="totalCost"
                  stroke="#6366f1"
                  strokeWidth={3}
                  dot={{ fill: '#6366f1', strokeWidth: 2 }}
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </div>

        {/* Daily Usage (last 30 days) */}
        <div className="bg-slate-800/40 rounded-xl border border-white/5 p-6">
          <h3 className="text-lg font-semibold text-white mb-4">Daily Token Usage</h3>
          <div className="h-64">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={dailyData.slice(-30)}>
                <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
                <XAxis
                  dataKey="date"
                  stroke="#94a3b8"
                  fontSize={10}
                  tickFormatter={(d) => new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                />
                <YAxis stroke="#94a3b8" fontSize={12} tickFormatter={(v) => `${(v / 1000).toFixed(0)}K`} />
                <Tooltip
                  contentStyle={{ backgroundColor: '#1e293b', border: '1px solid #334155', borderRadius: '8px' }}
                  labelStyle={{ color: '#f1f5f9' }}
                  formatter={(value: number) => [`${(value / 1000).toFixed(1)}K`, 'Tokens']}
                />
                <Bar dataKey="tokens" fill="#8b5cf6" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>

        {/* Model Distribution */}
        <div className="bg-slate-800/40 rounded-xl border border-white/5 p-6">
          <h3 className="text-lg font-semibold text-white mb-4">Model Usage Distribution</h3>
          <div className="h-64 flex items-center">
            <ResponsiveContainer width="50%" height="100%">
              <PieChart>
                <Pie
                  data={modelData}
                  cx="50%"
                  cy="50%"
                  innerRadius={50}
                  outerRadius={80}
                  dataKey="tokens"
                  paddingAngle={2}
                >
                  {modelData.map((entry, index) => (
                    <Cell key={entry.model} fill={COLORS[index % COLORS.length]} />
                  ))}
                </Pie>
                <Tooltip
                  contentStyle={{ backgroundColor: '#1e293b', border: '1px solid #334155', borderRadius: '8px' }}
                  formatter={(value: number) => [`${(value / 1000).toFixed(0)}K tokens`, '']}
                />
              </PieChart>
            </ResponsiveContainer>
            <div className="flex-1 space-y-2">
              {modelData.slice(0, 5).map((model, i) => (
                <div key={model.model} className="flex items-center gap-2">
                  <div className="w-3 h-3 rounded-full" style={{ backgroundColor: COLORS[i % COLORS.length] }} />
                  <span className="text-sm text-slate-300 truncate flex-1">{model.model}</span>
                  <span className="text-xs text-slate-500">{model.percentage.toFixed(1)}%</span>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Weekday Pattern */}
        <div className="bg-slate-800/40 rounded-xl border border-white/5 p-6">
          <h3 className="text-lg font-semibold text-white mb-4">Usage by Day of Week</h3>
          <div className="h-64">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={weekdayData}>
                <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
                <XAxis dataKey="day" stroke="#94a3b8" fontSize={12} tickFormatter={(d) => d.slice(0, 3)} />
                <YAxis stroke="#94a3b8" fontSize={12} tickFormatter={(v) => `${(v / 1000).toFixed(0)}K`} />
                <Tooltip
                  contentStyle={{ backgroundColor: '#1e293b', border: '1px solid #334155', borderRadius: '8px' }}
                  labelStyle={{ color: '#f1f5f9' }}
                  formatter={(value: number) => [`${(value / 1000).toFixed(1)}K avg`, 'Tokens']}
                />
                <Bar dataKey="avgTokens" fill="#a855f7" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      </div>
    </div>
  );
};

export default HistoryView;
