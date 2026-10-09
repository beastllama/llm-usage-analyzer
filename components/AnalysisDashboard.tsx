import React, { useState, useEffect, useMemo, useRef } from 'react';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  PieChart, Pie, Cell,
} from 'recharts';
import {
  Download, FileText, FileSpreadsheet, Scale, MoreHorizontal, ChevronDown,
  RefreshCw, Sparkles, MessageCircle, Share2, Check, AlertTriangle,
} from 'lucide-react';
import { UsageReport } from '../types';
import { calculateAnalysis, analyzeUsagePattern } from '../services/analysisService';
import { describeAnswer } from '../services/answer';
import { buildAiQuestion, buildShareLine, copyText } from '../services/shareService';
import { ESTIMATED_MODEL } from '../services/fileImport';
import { PLANS, PLAN_KEYS, PlanKey, toPlanKey } from '../services/pricing';
import { formatCount, formatDay, formatTokenNumber, formatUsd, formatApproxUsd, parseDay, plain } from '../services/format';
import { safeLocal } from '../services/safeStorage';
import { exportToJSON, exportToCSV, exportToPDF } from '../services/exportService';
import PlanComparison from './PlanComparison';
import PlanFitAnalyzer from './PlanFitAnalyzer';

export interface LiveStatus {
  connected: boolean;
  /** When the numbers were last read from the local analyzer (ms since 1970), or null. */
  updatedAt: number | null;
}

interface DashboardProps {
  data: UsageReport;
  onReset: () => void;
  isLiveData?: boolean;
  live?: LiveStatus;
  /** Read the numbers again. Resolves true when it worked. */
  onLiveRefresh?: () => Promise<boolean>;
}

const COLORS = ['#818cf8', '#c084fc', '#f472b6', '#fb7185', '#fbbf24', '#34d399', '#22d3ee', '#a3a3a3'];
const PLAN_STORAGE_KEY = 'selectedPlan';
const MAX_FILLED_DAYS = 400;

type Panel = 'compare' | 'pattern' | null;

/** The daily rows with the quiet days filled in as zero, so the chart's time axis has no gaps. */
function withQuietDays(days: UsageReport['usage']['messages']['by_day']) {
  if (days.length < 2) return days;
  const byDate = new Map(days.map((d) => [d.date, d]));
  const first = parseDay(days[0].date);
  const last = parseDay(days[days.length - 1].date);
  if ((last.getTime() - first.getTime()) / 86_400_000 > MAX_FILLED_DAYS) return days;
  const out: typeof days = [];
  for (const d = new Date(first); d <= last; d.setDate(d.getDate() + 1)) {
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    out.push(byDate.get(key) ?? { date: key, count: 0, input: 0, output: 0 });
  }
  return out;
}

const AnalysisDashboard: React.FC<DashboardProps> = ({ data, onReset, isLiveData, live, onLiveRefresh }) => {
  const storedPlan = useMemo(() => toPlanKey(safeLocal.get(PLAN_STORAGE_KEY)), []);
  const [selectedPlan, setSelectedPlan] = useState<PlanKey>(storedPlan ?? 'Claude Pro');
  // Until the person picks a plan, the answer uses Pro and says so
  const [planChosen, setPlanChosen] = useState(storedPlan !== null);
  const choosePlan = (key: PlanKey) => { setSelectedPlan(key); setPlanChosen(true); };
  const [panel, setPanel] = useState<Panel>(null);
  const [showDetails, setShowDetails] = useState(false);
  const [showMore, setShowMore] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const moreWrapRef = useRef<HTMLDivElement>(null);
  const moreButtonRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);

  const cmp = useMemo(() => calculateAnalysis(data, selectedPlan), [data, selectedPlan]);
  const pattern = useMemo(() => analyzeUsagePattern(data), [data]);
  const answer = useMemo(() => describeAnswer(cmp), [cmp]);
  const warnings = answer.caveats.filter((c) => !c.startsWith('Early guess'));
  const dailyRows = useMemo(() => withQuietDays(data.usage.messages.by_day), [data]);
  const totalTokens = data.usage.tokens.input + data.usage.tokens.output;
  const inputShare = totalTokens > 0 ? (data.usage.tokens.input / totalTokens) * 100 : 0;
  const isDemo = data.source === 'demo';
  const isWebExport = Object.keys(data.usage.tokens.by_model).includes(ESTIMATED_MODEL);

  useEffect(() => { if (planChosen) safeLocal.set(PLAN_STORAGE_KEY, selectedPlan); }, [selectedPlan, planChosen]);

  // Land on the page heading, so a keyboard or screen-reader user starts at the top of the new screen
  useEffect(() => {
    window.scrollTo(0, 0);
    headingRef.current?.focus({ preventScroll: true });
  }, []);

  // Escape closes the open menu or panel. Clicking elsewhere closes the menu.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (showMore) {
        setShowMore(false);
        moreButtonRef.current?.focus();
      } else if (panel) {
        setPanel(null);
      }
    };
    const onPointer = (e: MouseEvent) => {
      if (showMore && moreWrapRef.current && !moreWrapRef.current.contains(e.target as Node)) setShowMore(false);
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('mousedown', onPointer);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('mousedown', onPointer);
    };
  }, [showMore, panel]);

  // A short confirmation that clears itself
  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), 5000);
    return () => clearTimeout(t);
  }, [notice]);

  const handleRefresh = async () => {
    if (!onLiveRefresh) return;
    setIsRefreshing(true);
    const ok = await onLiveRefresh();
    setIsRefreshing(false);
    setNotice(ok ? 'Updated.' : "Couldn't refresh. The analyzer may have stopped. Run npx llm-usage-analyzer again.");
  };

  const openPanel = (next: Panel) => {
    setPanel(next);
    setShowMore(false);
    // Bring the panel into view and move focus to it, so it is clear that something opened
    requestAnimationFrame(() => {
      panelRef.current?.scrollIntoView({ block: 'start' });
      panelRef.current?.focus({ preventScroll: true });
    });
  };

  const handleExport = (format: 'json' | 'csv' | 'pdf') => {
    setShowMore(false);
    if (format === 'json') setNotice(`Saved ${exportToJSON(data)}. Check your downloads.`);
    if (format === 'csv') setNotice(`Saved ${exportToCSV(data, selectedPlan)}. Check your downloads.`);
    if (format === 'pdf') {
      exportToPDF(data, selectedPlan);
      setNotice('Opening a print page in a new tab. If nothing opens, allow pop-ups for this page.');
    }
  };

  const copyAndTell = async (text: string, done: string) => {
    setShowMore(false);
    setNotice((await copyText(text)) ? done : 'Could not copy. Your browser blocked it.');
  };

  const shareLine = isDemo ? null : buildShareLine(cmp);

  // The answer only makes sense for Claude usage with at least one priced model
  const comparable = data.provider === 'anthropic' && cmp.canJudge && totalTokens > 0;
  const nothingToCompare = totalTokens === 0
    ? { title: 'No Claude usage found yet', text: isLiveData ? 'Use Claude Code for a while, then press Refresh.' : 'There is no usage in this file.' }
    : isWebExport
      ? { title: "Here's your claude.ai activity", text: "claude.ai doesn't say which model replied, so we can't price it. For your real limit, open claude.ai, then Settings → Usage." }
      : data.provider !== 'anthropic'
        ? { title: 'Nothing to compare yet', text: 'This report is not from Claude. The comparison covers Claude plans only.' }
        : { title: 'Nothing to compare yet', text: "We don't have prices for the models you used, so we can't compare costs." };

  const dateRange = useMemo(() => {
    const months = new Set(data.usage.messages.by_day.map((d) => d.date.slice(0, 7)));
    return { spansMultipleMonths: months.size > 1 };
  }, [data]);

  const formatXAxisDate = (key: string) => {
    const date = parseDay(key);
    return dateRange.spansMultipleMonths ? formatDay(key) : String(date.getDate());
  };

  const modelBreakdown = useMemo(() => {
    const rows: Array<{ name: string; value: number }> = [];
    for (const [name, t] of Object.entries(data.usage.tokens.by_model)) {
      rows.push({ name: plain(name).replace(/^claude-/, ''), value: t.input + t.output });
    }
    return rows.filter((r) => r.value > 0);
  }, [data]);

  const modelTotal = modelBreakdown.reduce((sum, r) => sum + r.value, 0);

  return (
    <div className="max-w-5xl mx-auto px-4 py-8 space-y-6 pb-20">
      {/* Header: title, and at most three buttons */}
      <header className="relative flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
        <div>
          <h1 ref={headingRef} tabIndex={-1} className="text-2xl font-bold text-white outline-none">Your usage</h1>
          <p className="text-slate-300 text-sm">
            {new Date(data.period.start).toLocaleDateString()} to {new Date(data.period.end).toLocaleDateString()}
          </p>
          {isLiveData && live && (
            <p role="status" className={`text-sm mt-1 flex items-center gap-1.5 ${live.connected ? 'text-slate-300' : 'text-amber-200'}`}>
              {live.connected
                ? <><Check className="w-3.5 h-3.5 text-green-400" aria-hidden="true" /> Read from this computer{live.updatedAt ? ` at ${new Date(live.updatedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}` : ''}</>
                : <><AlertTriangle className="w-3.5 h-3.5" aria-hidden="true" /> Stopped. Run npx llm-usage-analyzer again.</>}
            </p>
          )}
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          {isLiveData && (
            <button
              onClick={handleRefresh}
              disabled={isRefreshing}
              className="text-sm flex items-center gap-2 px-4 min-h-11 rounded-lg border border-slate-500 text-slate-100 hover:bg-slate-800 disabled:opacity-60 disabled:cursor-not-allowed"
            >
              <RefreshCw className={`w-4 h-4 ${isRefreshing ? 'motion-safe:animate-spin' : ''}`} aria-hidden="true" />
              {isRefreshing ? 'Reading…' : 'Refresh'}
            </button>
          )}

          <div ref={moreWrapRef}>
            <button
              ref={moreButtonRef}
              onClick={() => setShowMore(!showMore)}
              aria-expanded={showMore}
              aria-controls="more-actions"
              className="text-sm flex items-center gap-2 px-4 min-h-11 rounded-lg text-slate-200 hover:bg-slate-800"
            >
              <MoreHorizontal className="w-4 h-4" aria-hidden="true" /> More
            </button>
            {showMore && (
              <div id="more-actions" className="absolute left-0 right-0 md:left-auto md:right-0 md:w-72 top-full mt-2 bg-slate-900 border border-white/15 rounded-xl shadow-xl z-30 overflow-hidden">
                <ul>
                  {comparable && (
                    <li><MenuItem icon={<Scale className="w-4 h-4" />} onClick={() => openPanel('compare')}>Compare plans</MenuItem></li>
                  )}
                  <li><MenuItem icon={<Sparkles className="w-4 h-4" />} onClick={() => openPanel('pattern')}>Usage pattern</MenuItem></li>
                  {comparable && !isDemo && (
                    <li className="border-t border-white/10">
                      <MenuItem icon={<MessageCircle className="w-4 h-4" />} onClick={() => copyAndTell(buildAiQuestion(data, cmp, pattern), 'Copied. Paste it into any AI.')}>Copy for an AI</MenuItem>
                    </li>
                  )}
                  {shareLine && (
                    <li><MenuItem icon={<Share2 className="w-4 h-4" />} onClick={() => copyAndTell(shareLine, 'Copied a short note to share.')}>Copy a short note</MenuItem></li>
                  )}
                  <li className="border-t border-white/10"><MenuItem icon={<FileSpreadsheet className="w-4 h-4" />} onClick={() => handleExport('csv')}>Save as spreadsheet (CSV)</MenuItem></li>
                  <li><MenuItem icon={<FileText className="w-4 h-4" />} onClick={() => handleExport('json')}>Save as JSON</MenuItem></li>
                  <li><MenuItem icon={<Download className="w-4 h-4" />} onClick={() => handleExport('pdf')}>Print or save as PDF</MenuItem></li>
                </ul>
              </div>
            )}
          </div>

          <button onClick={onReset} className="text-sm px-4 min-h-11 rounded-lg bg-indigo-500 hover:bg-indigo-400 text-white font-medium">
            New analysis
          </button>
        </div>
      </header>

      {isDemo && (
        <div className="flex flex-wrap items-center gap-x-3 text-sm text-amber-100 bg-amber-500/10 border border-amber-500/30 rounded-lg px-4">
          <span className="py-2.5">Sample data, not yours.</span>
          <button onClick={onReset} className="underline hover:text-white min-h-11">Use your own</button>
        </div>
      )}

      {/* A reserved line, so a message appearing does not push the page down */}
      <div role="status" aria-live="polite" className="min-h-9">
        {notice && (
          <p className="inline-flex items-center gap-2 text-sm text-green-200 bg-green-500/10 border border-green-500/30 rounded-lg px-3 py-1.5">
            <Check className="w-4 h-4" aria-hidden="true" /> {notice}
          </p>
        )}
      </div>

      {/* The answer: one card, one sentence, plain numbers */}
      <section aria-labelledby="answer-title" className="bg-slate-800/60 border border-slate-700 rounded-2xl p-6 md:p-8 space-y-6">
        <div>
          <p className="text-xs uppercase tracking-wide text-slate-300">Your answer</p>
          {comparable ? (
            <>
              {cmp.lowConfidence && (
                <p className="inline-block text-xs font-medium text-amber-100 bg-amber-500/15 border border-amber-500/30 rounded-full px-2.5 py-0.5 mt-2">Early guess: under a week of data</p>
              )}
              <h2 id="answer-title" className="text-2xl md:text-3xl font-bold text-white mt-1">{answer.headline}</h2>
              <p className="text-slate-200 mt-2">{answer.detail}</p>
              {warnings.length > 0 && (
                <ul className="mt-3 space-y-1 text-sm text-amber-100">
                  {warnings.map((c) => <li key={c} className="flex gap-2"><AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" aria-hidden="true" />{c}</li>)}
                </ul>
              )}
              {!planChosen && (
                <p className="text-sm text-slate-300 mt-2">Not on Pro? Pick your plan below.</p>
              )}
            </>
          ) : (
            <>
              <h2 id="answer-title" className="text-2xl font-bold text-white mt-1">{nothingToCompare.title}</h2>
              <p className="text-slate-200 mt-2">{nothingToCompare.text}</p>
              {totalTokens > 0 && (
                <p className="text-slate-300 mt-2 text-sm">
                  {formatCount(data.usage.messages.count)} replies on {pattern.activeDays} of {pattern.periodDays} days.
                </p>
              )}
              {cmp.unpricedModels.length > 0 && !isWebExport && totalTokens > 0 && (
                <p className="text-sm text-amber-100 mt-2">No price known for: {cmp.unpricedModels.map(plain).join(', ')}.</p>
              )}
            </>
          )}
        </div>

        {/* Plan choice as a simple radio group */}
        {comparable && (
          <fieldset>
            <legend className="text-sm text-slate-300 mb-2">Which plan do you pay for?</legend>
            <div className="flex flex-wrap gap-2">
              {PLAN_KEYS.map((key) => (
                <label
                  key={key}
                  className={`cursor-pointer px-4 min-h-11 flex items-center gap-2 rounded-lg border text-sm font-medium focus-within:ring-2 focus-within:ring-indigo-300 ${
                    key === selectedPlan
                      ? 'bg-indigo-500 border-indigo-300 text-white'
                      : 'bg-slate-900/40 border-slate-500 text-slate-200 hover:border-slate-300'
                  }`}
                >
                  <input
                    type="radio"
                    name="plan"
                    value={key}
                    checked={key === selectedPlan}
                    onChange={() => choosePlan(key)}
                    className="sr-only"
                  />
                  {key === selectedPlan && <Check className="w-4 h-4" aria-hidden="true" />}
                  {key} · {formatUsd(PLANS[key].price)}/mo
                </label>
              ))}
            </div>
          </fieldset>
        )}

        {comparable && (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="bg-slate-900/50 rounded-xl p-4">
              <div className="text-xs text-slate-300">Your plan</div>
              <div className="text-3xl font-bold text-white">{formatUsd(cmp.planPrice)}<span className="text-base text-slate-300 font-normal">/mo</span></div>
            </div>
            <div className="bg-slate-900/50 rounded-xl p-4">
              <div className="text-xs text-slate-300">{cmp.lowerBound ? 'Pay-as-you-go (at least)' : 'Pay-as-you-go (estimate)'}</div>
              <div className="text-3xl font-bold text-white">{cmp.lowerBound ? formatApproxUsd(cmp.apiCostMonthly) : formatUsd(cmp.apiCostMonthly)}<span className="text-base text-slate-300 font-normal">/mo</span></div>
            </div>
          </div>
        )}

        {comparable && (
          <p className="text-sm text-slate-300">
            Price only. Plans also differ in how much you can use. Anthropic doesn't publish exact limits.
          </p>
        )}

        {totalTokens > 0 && (
          <button
            onClick={() => setShowDetails(!showDetails)}
            aria-expanded={showDetails}
            aria-controls="details"
            className="flex items-center gap-2 text-sm text-indigo-200 hover:text-white min-h-11"
          >
            {showDetails ? 'Hide details' : 'Show details'}
            <ChevronDown className={`w-4 h-4 transition-transform ${showDetails ? 'rotate-180' : ''}`} aria-hidden="true" />
          </button>
        )}
      </section>

      {/* Optional panels: one at a time */}
      {panel && (
        <div ref={panelRef} tabIndex={-1} className="outline-none scroll-mt-24">
          {panel === 'compare' && (
            <PlanComparison data={data} selectedPlan={selectedPlan} onSelect={choosePlan} onClose={() => setPanel(null)} />
          )}
          {panel === 'pattern' && (
            <section aria-label="Usage pattern" className="bg-slate-800/40 border border-white/10 rounded-2xl p-6 relative">
              <button onClick={() => setPanel(null)} className="absolute top-3 right-3 text-sm text-slate-200 hover:text-white min-h-11 px-3">Close</button>
              <PlanFitAnalyzer data={data} showCliHint={!isWebExport} />
            </section>
          )}
        </div>
      )}

      {/* Details: collapsed by default */}
      {showDetails && totalTokens > 0 && (
        <section id="details" aria-label="Details" className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <div className="bg-slate-800/50 border border-slate-700/50 rounded-xl p-6 lg:col-span-2">
            <h3 className="text-lg font-semibold text-white mb-1">Daily replies</h3>
            <p className="text-sm text-slate-300 mb-4">
              {pattern.peakDay ? `Busiest day: ${formatDay(pattern.peakDay.date)}, ${formatCount(pattern.peakDay.count)} replies.` : 'No replies yet.'}
            </p>
            <div className="h-[260px] w-full" role="img" aria-label={`Bar chart of replies per day. ${pattern.peakDay ? `Busiest day: ${formatDay(pattern.peakDay.date)}, ${pattern.peakDay.count} replies.` : ''}`}>
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={dailyRows} accessibilityLayer={false}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#334155" vertical={false} />
                  <XAxis dataKey="date" tickFormatter={formatXAxisDate} stroke="#cbd5e1" fontSize={12} />
                  <YAxis stroke="#cbd5e1" fontSize={12} allowDecimals={false} />
                  <Tooltip
                    contentStyle={{ backgroundColor: '#1e293b', borderColor: '#334155', color: '#f8fafc' }}
                    labelFormatter={(key: string) => formatDay(key)}
                    formatter={(value: number) => [formatCount(value), 'Replies']}
                  />
                  <Bar dataKey="count" fill="#818cf8" radius={[4, 4, 0, 0]} isAnimationActive={false} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>

          {!isWebExport && modelBreakdown.length > 0 && (
            <div className="bg-slate-800/50 border border-slate-700/50 rounded-xl p-6">
              <h3 className="text-lg font-semibold text-white mb-4">Models</h3>
              <div
                className="h-[200px] w-full"
                role="img"
                aria-label={`Pie chart of tokens by model. ${modelBreakdown.slice(0, 5).map((r) => `${r.name} ${Math.round((r.value / modelTotal) * 100)}%`).join(', ')}`}
              >
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart accessibilityLayer={false}>
                    <Pie data={modelBreakdown} cx="50%" cy="50%" innerRadius={55} outerRadius={80} paddingAngle={4} dataKey="value" isAnimationActive={false}>
                      {modelBreakdown.map((entry, index) => (
                        <Cell key={entry.name} fill={COLORS[index % COLORS.length]} />
                      ))}
                    </Pie>
                    <Tooltip
                      contentStyle={{ backgroundColor: '#1e293b', borderColor: '#334155', color: '#f8fafc' }}
                      formatter={(value: number) => `${formatTokenNumber(value)} tokens`}
                    />
                  </PieChart>
                </ResponsiveContainer>
              </div>
              <ul className="flex flex-wrap gap-x-4 gap-y-1 justify-center mt-2 text-sm text-slate-200">
                {modelBreakdown.map((entry, index) => (
                  <li key={entry.name} className="flex items-center gap-1.5">
                    <span className="w-3 h-3 rounded-full" style={{ backgroundColor: COLORS[index % COLORS.length] }} aria-hidden="true" />
                    {entry.name} <span className="text-slate-300">{Math.round((entry.value / modelTotal) * 100)}%</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="bg-slate-800/50 border border-slate-700/50 rounded-xl p-6">
            <h3 className="text-lg font-semibold text-white mb-4">Sent and received</h3>
            <div className="space-y-5">
              <Meter label="Sent (what you wrote)" value={data.usage.tokens.input} percent={inputShare} barClass="bg-indigo-400" />
              <Meter label="Received (what Claude wrote)" value={data.usage.tokens.output} percent={100 - inputShare} barClass="bg-emerald-400" />
            </div>
            {data.usage.tokens.cached ? (
              <p className="text-sm text-slate-300 mt-4">Reused text: {formatTokenNumber(data.usage.tokens.cached)} tokens, billed at a cheaper rate.</p>
            ) : null}
            <p className="text-xs text-slate-300 mt-3">
              A token is a small piece of text, about 4 characters.{isWebExport ? ' These are estimated from text length.' : ''}
            </p>
          </div>
        </section>
      )}

      <p className="text-xs text-slate-300">
        Everything here runs on your computer. Nothing is sent anywhere. Unofficial: not affiliated with Anthropic.
      </p>
    </div>
  );
};

const MenuItem: React.FC<{ icon: React.ReactNode; onClick: () => void; children: React.ReactNode }> = ({ icon, onClick, children }) => (
  <button onClick={onClick} className="w-full px-4 min-h-11 text-left text-sm text-slate-100 hover:bg-white/10 flex items-center gap-3">
    <span className="text-slate-300" aria-hidden="true">{icon}</span>
    {children}
  </button>
);

const Meter: React.FC<{ label: string; value: number; percent: number; barClass: string }> = ({ label, value, percent, barClass }) => (
  <div>
    <div className="flex justify-between text-sm mb-1">
      <span className="text-slate-200">{label}</span>
      <span className="text-white">{formatTokenNumber(value)}</span>
    </div>
    <div className="w-full bg-slate-700 rounded-full h-2 overflow-hidden" role="presentation">
      <div className={`${barClass} h-2 rounded-full`} style={{ width: `${Number.isFinite(percent) ? percent : 0}%` }} />
    </div>
  </div>
);

export default AnalysisDashboard;
