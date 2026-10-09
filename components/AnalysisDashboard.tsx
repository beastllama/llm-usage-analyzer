import React, { useState, useEffect, useMemo, useRef } from 'react';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  PieChart, Pie, Cell
} from 'recharts';
import { Download, FileText, FileSpreadsheet, Copy, Check, Scale, MoreHorizontal, ChevronDown, RefreshCw, Sparkles, Eye, EyeOff } from 'lucide-react';
import { UsageReport } from '../types';
import { calculateAnalysis, analyzeUsagePattern, formatTokenNumber, formatUsd } from '../services/analysisService';
import { aiPayloadPreview, getGeminiRecommendation, AiResult } from '../services/geminiService';
import { PLANS, PLAN_KEYS, PlanKey, toPlanKey } from '../services/pricing';
import PlanComparison from './PlanComparison';
import PlanFitAnalyzer from './PlanFitAnalyzer';
import { exportToJSON, exportToCSV, exportToPDF, copyToClipboard } from '../services/exportService';

interface DashboardProps {
  data: UsageReport;
  onReset: () => void;
  isLiveData?: boolean;
  liveServerConnected?: boolean;
  onLiveRefresh?: () => Promise<void>;
}

const COLORS = ['#6366f1', '#8b5cf6', '#ec4899', '#f43f5e'];
const PLAN_STORAGE_KEY = 'selectedPlan';

type Panel = 'compare' | 'pattern' | null;

const AnalysisDashboard: React.FC<DashboardProps> = ({ data, onReset, isLiveData, liveServerConnected, onLiveRefresh }) => {
  const [selectedPlan, setSelectedPlan] = useState<PlanKey>(() => {
    try {
      return toPlanKey(localStorage.getItem(PLAN_STORAGE_KEY)) ?? 'Claude Pro';
    } catch {
      return 'Claude Pro';
    }
  });
  const [panel, setPanel] = useState<Panel>(null);
  const [showDetails, setShowDetails] = useState(false);
  const [showMore, setShowMore] = useState(false);
  const [copied, setCopied] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);

  // AI tip: off until the user asks. The key lives in memory only, for this page.
  const [aiOpen, setAiOpen] = useState(false);
  const [aiKey, setAiKey] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [aiState, setAiState] = useState<{ status: 'idle' | 'loading' | 'done' | 'error'; text?: string; error?: string }>({ status: 'idle' });

  const cmp = useMemo(() => calculateAnalysis(data, selectedPlan), [data, selectedPlan]);
  const pattern = useMemo(() => analyzeUsagePattern(data), [data]);
  const totalTokens = data.usage.tokens.input + data.usage.tokens.output;
  const inputShare = totalTokens > 0 ? (data.usage.tokens.input / totalTokens) * 100 : 0;

  useEffect(() => {
    try {
      localStorage.setItem(PLAN_STORAGE_KEY, selectedPlan);
    } catch {
      // Storage blocked. The choice still works for this visit.
    }
  }, [selectedPlan]);

  // A different report or plan makes the old AI answer stale
  // Each request gets a number. A reply that arrives after the report or plan changed is ignored.
  const requestRef = useRef(0);
  useEffect(() => {
    requestRef.current++;
    setAiState({ status: 'idle' });
  }, [data, selectedPlan]);

  // Escape closes open menus
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setShowMore(false);
        setPanel(null);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const handleRefresh = async () => {
    if (!onLiveRefresh) return;
    setIsRefreshing(true);
    await onLiveRefresh();
    setIsRefreshing(false);
  };

  const handleExport = (format: 'json' | 'csv' | 'pdf') => {
    setShowMore(false);
    if (format === 'json') exportToJSON(data);
    if (format === 'csv') exportToCSV(data);
    if (format === 'pdf') exportToPDF(data);
  };

  const handleCopy = async () => {
    const success = await copyToClipboard(data);
    setShowMore(false);
    setCopied(success);
    if (success) setTimeout(() => setCopied(false), 2000);
  };

  const askAi = async () => {
    const id = ++requestRef.current;
    setAiState({ status: 'loading' });
    const result: AiResult = await getGeminiRecommendation(aiKey, data, cmp, pattern);
    if (id !== requestRef.current) return;
    if ('error' in result) {
      setAiState({ status: 'error', error: result.error });
    } else {
      setAiState({ status: 'done', text: result.text });
    }
  };

  // The verdict only makes sense for Claude usage with at least one priced model
  const comparable = data.provider === 'anthropic' && cmp.canJudge && totalTokens > 0;
  const notComparableReason = totalTokens === 0
    ? 'No usage found in this period.'
    : data.provider !== 'anthropic'
      ? 'This report is from OpenAI. The plan comparison covers Claude plans only.'
      : 'None of the models in this file have a known price, so cost cannot be compared.';

  const headline = cmp.verdict === 'keep'
    ? `Your ${selectedPlan} plan costs less than pay-as-you-go.`
    : `Pay-as-you-go would cost less than your ${selectedPlan} plan.`;

  const dateRange = useMemo(() => {
    const months = new Set(data.usage.messages.by_day.map(d => d.date.slice(0, 7)));
    return { spansMultipleMonths: months.size > 1 };
  }, [data]);

  const formatXAxisDate = (dateStr: string) => {
    const [y, m, d] = dateStr.split('-').map(Number);
    const date = new Date(y, m - 1, d);
    return dateRange.spansMultipleMonths
      ? date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
      : String(date.getDate());
  };

  const modelBreakdown = useMemo(() => {
    const rows: Array<{ name: string; value: number }> = [];
    for (const [name, t] of Object.entries(data.usage.tokens.by_model)) {
      rows.push({ name: name.replace('claude-', ''), value: t.input + t.output });
    }
    return rows;
  }, [data]);

  return (
    <div className="max-w-5xl mx-auto px-4 py-8 space-y-6 pb-20">
      {/* Header: title, plan choice, and at most two buttons */}
      <header className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
        <div>
          <h2 className="text-2xl font-bold text-white flex items-center gap-2 flex-wrap">
            Your usage
            {isLiveData && liveServerConnected && (
              <span className="text-xs font-medium text-red-300 bg-red-500/10 px-3 py-1 rounded-full border border-red-500/30">Live</span>
            )}
            {isLiveData && !liveServerConnected && (
              <span className="text-xs font-medium text-amber-300 bg-amber-500/10 px-3 py-1 rounded-full border border-amber-500/30">Disconnected</span>
            )}
          </h2>
          <p className="text-slate-400 text-sm">
            {new Date(data.period.start).toLocaleDateString()} to {new Date(data.period.end).toLocaleDateString()}
          </p>
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          {isLiveData && (
            <button
              onClick={handleRefresh}
              disabled={isRefreshing || !liveServerConnected}
              className="text-sm flex items-center gap-2 px-4 py-2 rounded-lg border border-slate-600 text-slate-200 hover:bg-slate-800 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <RefreshCw className={`w-4 h-4 ${isRefreshing ? 'animate-spin' : ''}`} aria-hidden="true" />
              {isRefreshing ? 'Refreshing' : 'Refresh'}
            </button>
          )}

          <div className="relative">
            <button
              onClick={() => setShowMore(!showMore)}
              aria-haspopup="menu"
              aria-expanded={showMore}
              className="text-sm flex items-center gap-2 px-4 py-2 rounded-lg text-slate-300 hover:bg-slate-800"
            >
              <MoreHorizontal className="w-4 h-4" aria-hidden="true" /> More
            </button>
            {showMore && (
              <>
                <div className="fixed inset-0 z-40" onClick={() => setShowMore(false)} aria-hidden="true" />
                <div role="menu" className="absolute right-0 mt-2 w-56 bg-slate-900 border border-white/10 rounded-xl shadow-xl z-50 overflow-hidden">
                  {comparable && (
                    <MenuItem icon={<Scale className="w-4 h-4" />} onClick={() => { setPanel('compare'); setShowMore(false); }}>Compare plans</MenuItem>
                  )}
                  <MenuItem icon={<Sparkles className="w-4 h-4" />} onClick={() => { setPanel('pattern'); setShowMore(false); }}>Usage pattern</MenuItem>
                  <div className="border-t border-white/5" />
                  <MenuItem icon={<FileText className="w-4 h-4" />} onClick={() => handleExport('json')}>Export JSON</MenuItem>
                  <MenuItem icon={<FileSpreadsheet className="w-4 h-4" />} onClick={() => handleExport('csv')}>Export CSV</MenuItem>
                  <MenuItem icon={<Download className="w-4 h-4" />} onClick={() => handleExport('pdf')}>Print / save PDF</MenuItem>
                  <MenuItem icon={copied ? <Check className="w-4 h-4 text-green-400" /> : <Copy className="w-4 h-4" />} onClick={handleCopy}>
                    {copied ? 'Copied' : 'Copy summary'}
                  </MenuItem>
                </div>
              </>
            )}
          </div>

          <button onClick={onReset} className="text-sm px-4 py-2 rounded-lg bg-indigo-500 hover:bg-indigo-400 text-white font-medium">
            New analysis
          </button>
        </div>
      </header>

      {/* The answer: one card, one sentence, plain numbers */}
      <section aria-labelledby="answer-title" className="bg-slate-800/60 border border-slate-700 rounded-2xl p-6 md:p-8 space-y-6">
        <div>
          <p className="text-xs uppercase tracking-wide text-slate-400">Your answer</p>
          {comparable ? (
            <>
              <h3 id="answer-title" className="text-2xl md:text-3xl font-bold text-white mt-1">{headline}</h3>
              <p className="text-slate-300 mt-2">
                Difference: <span className="font-semibold text-white">{formatUsd(cmp.difference)} per month</span> (estimate at list prices).
                {cmp.lowConfidence && <span className="block text-amber-300 text-sm mt-1">Based on under a week of data, so this is a rough guess.</span>}
              </p>
            </>
          ) : (
            <>
              <h3 id="answer-title" className="text-2xl font-bold text-white mt-1">Nothing to compare yet</h3>
              <p className="text-slate-300 mt-2">{notComparableReason}</p>
            </>
          )}
        </div>

        {/* Plan choice as a simple radio group */}
        {comparable && (
        <fieldset>
          <legend className="text-sm text-slate-400 mb-2">Which plan do you pay for?</legend>
          <div className="flex flex-wrap gap-2">
            {PLAN_KEYS.map(key => (
              <label
                key={key}
                className={`cursor-pointer px-4 py-2 rounded-lg border text-sm font-medium focus-within:ring-2 focus-within:ring-indigo-400 ${
                  key === selectedPlan
                    ? 'bg-indigo-500 border-indigo-400 text-white'
                    : 'bg-slate-900/40 border-slate-600 text-slate-300 hover:border-slate-400'
                }`}
              >
                <input
                  type="radio"
                  name="plan"
                  value={key}
                  checked={key === selectedPlan}
                  onChange={() => setSelectedPlan(key)}
                  className="sr-only"
                />
                {key} · {formatUsd(PLANS[key].price)}/mo
              </label>
            ))}
          </div>
        </fieldset>
        )}

        {comparable && (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div className="bg-slate-900/50 rounded-xl p-4">
            <div className="text-xs text-slate-400">Your plan</div>
            <div className="text-3xl font-bold text-white">{formatUsd(cmp.planPrice)}<span className="text-base text-slate-400 font-normal">/mo</span></div>
          </div>
          <div className="bg-slate-900/50 rounded-xl p-4">
            <div className="text-xs text-slate-400">Pay-as-you-go (estimate)</div>
            <div className="text-3xl font-bold text-white">{formatUsd(cmp.apiCostMonthly)}<span className="text-base text-slate-400 font-normal">/mo</span></div>
          </div>
        </div>
        )}

        {cmp.unpricedModels.length > 0 && (
          <p className="text-xs text-amber-300">
            Not counted, because no price is known: {cmp.unpricedModels.join(', ')}.
          </p>
        )}

        <button
          onClick={() => setShowDetails(!showDetails)}
          aria-expanded={showDetails}
          aria-controls="details"
          className="flex items-center gap-2 text-sm text-indigo-300 hover:text-white"
        >
          {showDetails ? 'Hide details' : 'Show details'}
          <ChevronDown className={`w-4 h-4 transition-transform ${showDetails ? 'rotate-180' : ''}`} aria-hidden="true" />
        </button>
      </section>

      {/* Optional panels: one at a time */}
      {panel === 'compare' && (
        <PlanComparison
          data={data}
          selectedPlan={selectedPlan}
          onSelect={setSelectedPlan}
          onClose={() => setPanel(null)}
        />
      )}
      {panel === 'pattern' && (
        <section aria-label="Usage pattern" className="bg-slate-800/40 border border-white/5 rounded-2xl p-6 relative">
          <button onClick={() => setPanel(null)} className="absolute top-4 right-4 text-sm text-slate-400 hover:text-white">Close</button>
          <PlanFitAnalyzer data={data} />
        </section>
      )}

      {/* Details: collapsed by default */}
      {showDetails && (
        <section id="details" aria-label="Details" className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <div className="bg-slate-800/50 border border-slate-700/50 rounded-xl p-6 lg:col-span-2">
            <h3 className="text-lg font-semibold text-white mb-4">Daily replies</h3>
            <div className="h-[260px] w-full">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={data.usage.messages.by_day}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#334155" vertical={false} />
                  <XAxis dataKey="date" tickFormatter={formatXAxisDate} stroke="#94a3b8" fontSize={12} />
                  <YAxis stroke="#94a3b8" fontSize={12} allowDecimals={false} />
                  <Tooltip
                    contentStyle={{ backgroundColor: '#1e293b', borderColor: '#334155', color: '#f8fafc' }}
                    formatter={(value: number) => [value, 'Replies']}
                  />
                  <Bar dataKey="count" fill="#6366f1" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>

          <div className="bg-slate-800/50 border border-slate-700/50 rounded-xl p-6">
            <h3 className="text-lg font-semibold text-white mb-4">Models</h3>
            <div className="h-[200px] w-full">
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie data={modelBreakdown} cx="50%" cy="50%" innerRadius={55} outerRadius={80} paddingAngle={4} dataKey="value">
                    {modelBreakdown.map((entry, index) => (
                      <Cell key={entry.name} fill={COLORS[index % COLORS.length]} />
                    ))}
                  </Pie>
                  <Tooltip
                    contentStyle={{ backgroundColor: '#1e293b', borderColor: '#334155', color: '#f8fafc' }}
                    formatter={(value: number) => formatTokenNumber(value)}
                  />
                </PieChart>
              </ResponsiveContainer>
            </div>
            <ul className="flex flex-wrap gap-3 justify-center mt-2 text-xs text-slate-400">
              {modelBreakdown.map((entry, index) => (
                <li key={entry.name} className="flex items-center gap-1">
                  <span className="w-3 h-3 rounded-full" style={{ backgroundColor: COLORS[index % COLORS.length] }} aria-hidden="true" />
                  {entry.name}
                </li>
              ))}
            </ul>
          </div>

          <div className="bg-slate-800/50 border border-slate-700/50 rounded-xl p-6">
            <h3 className="text-lg font-semibold text-white mb-4">Input and output</h3>
            <div className="space-y-5">
              <Meter label="Input (what you sent)" value={data.usage.tokens.input} percent={inputShare} barClass="bg-indigo-500" />
              <Meter label="Output (what came back)" value={data.usage.tokens.output} percent={100 - inputShare} barClass="bg-emerald-500" />
            </div>
            {data.usage.tokens.cached ? (
              <p className="text-xs text-slate-500 mt-4">Cache tokens: {formatTokenNumber(data.usage.tokens.cached)} (priced separately).</p>
            ) : null}
          </div>
        </section>
      )}

      {/* Optional AI tip: off by default, and only for Claude reports that can be compared */}
      {comparable && (
      <section aria-labelledby="ai-title" className="bg-slate-800/40 border border-white/5 rounded-2xl p-6">
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <div>
            <h3 id="ai-title" className="text-lg font-semibold text-white">Optional AI tip</h3>
            <p className="text-sm text-slate-400">Off unless you turn it on. Uses your own Gemini key.</p>
          </div>
          <button
            onClick={() => setAiOpen(!aiOpen)}
            aria-expanded={aiOpen}
            className="text-sm px-4 py-2 rounded-lg border border-slate-600 text-slate-200 hover:bg-slate-800"
          >
            {aiOpen ? 'Hide' : 'Turn on'}
          </button>
        </div>

        {aiOpen && (
          <div className="mt-5 space-y-4">
            <div className="text-sm text-slate-300">
              <p className="font-medium text-white mb-1">This will be sent to Google:</p>
              <ul className="list-disc list-inside text-slate-400">
                {aiPayloadPreview(data, cmp, pattern).map(line => <li key={line}>{line}</li>)}
              </ul>
              <p className="text-slate-500 mt-2">No file text, no names, no messages.</p>
            </div>

            <div>
              <label htmlFor="gemini-key" className="block text-sm text-slate-300 mb-1">Your Gemini API key</label>
              <div className="flex gap-2">
                <input
                  id="gemini-key"
                  type={showKey ? 'text' : 'password'}
                  value={aiKey}
                  onChange={(e) => setAiKey(e.target.value)}
                  autoComplete="off"
                  spellCheck={false}
                  className="flex-1 bg-slate-900 border border-slate-600 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-indigo-500"
                />
                <button
                  type="button"
                  onClick={() => setShowKey(!showKey)}
                  aria-label={showKey ? 'Hide key' : 'Show key'}
                  className="px-3 rounded-lg border border-slate-600 text-slate-300 hover:bg-slate-800"
                >
                  {showKey ? <EyeOff className="w-4 h-4" aria-hidden="true" /> : <Eye className="w-4 h-4" aria-hidden="true" />}
                </button>
              </div>
              <p className="text-xs text-slate-500 mt-1">Kept in this page only. It is not saved.</p>
            </div>

            <button
              onClick={askAi}
              disabled={!aiKey.trim() || aiState.status === 'loading'}
              className="text-sm px-4 py-2 rounded-lg bg-indigo-500 hover:bg-indigo-400 text-white font-medium disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {aiState.status === 'loading' ? 'Asking' : 'Get tip'}
            </button>

            <div role="status" aria-live="polite" className="text-sm text-slate-200">
              {aiState.status === 'done' && <p className="whitespace-pre-line">{aiState.text}</p>}
              {aiState.status === 'error' && <p className="text-amber-300">{aiState.error}</p>}
            </div>
          </div>
        )}
      </section>
      )}

      <p className="text-xs text-slate-500">
        Everything here runs in your browser, except the optional AI tip.
      </p>
    </div>
  );
};

const MenuItem: React.FC<{ icon: React.ReactNode; onClick: () => void; children: React.ReactNode }> = ({ icon, onClick, children }) => (
  <button role="menuitem" onClick={onClick} className="w-full px-4 py-3 text-left text-sm text-slate-200 hover:bg-white/5 flex items-center gap-3">
    <span className="text-slate-400" aria-hidden="true">{icon}</span>
    {children}
  </button>
);

const Meter: React.FC<{ label: string; value: number; percent: number; barClass: string }> = ({ label, value, percent, barClass }) => (
  <div>
    <div className="flex justify-between text-sm mb-1">
      <span className="text-slate-300">{label}</span>
      <span className="text-white">{formatTokenNumber(value)}</span>
    </div>
    <div className="w-full bg-slate-700 rounded-full h-2 overflow-hidden" role="presentation">
      <div className={`${barClass} h-2 rounded-full`} style={{ width: `${Number.isFinite(percent) ? percent : 0}%` }} />
    </div>
  </div>
);

export default AnalysisDashboard;
