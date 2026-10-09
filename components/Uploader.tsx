import React, { useState, useEffect, useRef } from 'react';
import {
  Upload, Play, Terminal, Key, FileJson,
  Bot, Sparkles, ChevronRight, Download, Server, AlertCircle,
  ArrowLeft, ShieldCheck, FileUp, Lock, EyeOff, Loader2, Calendar,
  ExternalLink, HelpCircle, Globe, Info, DollarSign, Wifi, RefreshCw
} from 'lucide-react';
import { UsageReport } from '../types';
import { PLANS, PLAN_KEYS, PlanKey } from '../services/pricing';
import { fetchOpenAIUsage, isValidOpenAIKey, testOpenAIConnection } from '../services/openaiService';

const MAX_FILE_BYTES = 50 * 1024 * 1024;

interface UploaderProps {
  onDataLoaded: (data: UsageReport, fromLiveServer?: boolean) => void;
  onLoadDemo: () => void;
}

type ViewState = 'main' | 'anthropic-options' | 'anthropic-cli' | 'anthropic-web' | 'openai' | 'openai-manual' | 'upload';

const Uploader: React.FC<UploaderProps> = ({ onDataLoaded, onLoadDemo }) => {
  const [view, setView] = useState<ViewState>('main');
  const [dragActive, setDragActive] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [apiKey, setApiKey] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [selectedPlan, setSelectedPlan] = useState<PlanKey>('Claude Pro');
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [dateRange, setDateRange] = useState({
    start: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0], // 30 days ago
    end: new Date().toISOString().split('T')[0], // today
  });

  // Local server detection state
  const [localServerStatus, setLocalServerStatus] = useState<'checking' | 'available' | 'unavailable'>('checking');
  const [localServerLoading, setLocalServerLoading] = useState(false);
  const LOCAL_SERVER_URL = 'http://localhost:3456';

  // Check for local server on mount and when CLI view is shown
  useEffect(() => {
    const checkLocalServer = async () => {
      setLocalServerStatus('checking');
      try {
        const response = await fetch(`${LOCAL_SERVER_URL}/api/health`, {
          method: 'GET',
          signal: AbortSignal.timeout(2000), // 2 second timeout
        });
        if (response.ok) {
          setLocalServerStatus('available');
        } else {
          setLocalServerStatus('unavailable');
        }
      } catch {
        setLocalServerStatus('unavailable');
      }
    };

    // Check immediately and when view changes to CLI
    if (view === 'anthropic-cli' || view === 'main') {
      checkLocalServer();
    }
  }, [view]);

  // A file dropped anywhere on the page should load here, not open in a new browser tab
  useEffect(() => {
    const block = (e: DragEvent) => e.preventDefault();
    window.addEventListener('dragover', block);
    window.addEventListener('drop', block);
    return () => {
      window.removeEventListener('dragover', block);
      window.removeEventListener('drop', block);
    };
  }, []);

  const loadFromLocalServer = async () => {
    setLocalServerLoading(true);
    setError(null);
    try {
      const response = await fetch(`${LOCAL_SERVER_URL}/api/usage`);
      if (!response.ok) {
        throw new Error('Failed to fetch usage data from local server');
      }
      const report = await response.json() as UsageReport;
      onDataLoaded(report, true); // true = from live server
    } catch (err) {
      setError(`Failed to load from local server: ${err instanceof Error ? err.message : 'Unknown error'}`);
    } finally {
      setLocalServerLoading(false);
    }
  };

  const refreshLocalServerCheck = async () => {
    setLocalServerStatus('checking');
    try {
      const response = await fetch(`${LOCAL_SERVER_URL}/api/health`, {
        method: 'GET',
        signal: AbortSignal.timeout(2000),
      });
      if (response.ok) {
        setLocalServerStatus('available');
      } else {
        setLocalServerStatus('unavailable');
      }
    } catch {
      setLocalServerStatus('unavailable');
    }
  };

  // --- Logic Helpers ---

  const handleDrag = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.type === "dragenter" || e.type === "dragover") {
      setDragActive(true);
    } else if (e.type === "dragleave") {
      setDragActive(false);
    }
  };

  const estimateTokens = (text: string) => Math.ceil(text.length / 4);

  const convertClaudeExportToUsageReport = (data: any[]): UsageReport => {
    const usage: UsageReport = {
      provider: 'anthropic',
      source: 'manual_upload',
      period: { start: new Date().toISOString(), end: new Date().toISOString() },
      plan: { name: selectedPlan, price_usd: PLANS[selectedPlan].price, type: 'subscription' },
      usage: {
        tokens: { input: 0, output: 0, cached: 0, by_model: {} },
        messages: { count: 0, by_day: [] },
        sessions: { count: data.length }
      }
    };

    let minDate = new Date();
    let maxDate = new Date(0);
    const dayMap: Record<string, { count: number; input: number; output: number }> = {};

    data.forEach((conversation: any) => {
      const created = new Date(conversation.created_at || Date.now());
      if (created < minDate) minDate = created;
      if (created > maxDate) maxDate = created;

      const dateKey = created.toISOString().split('T')[0];
      if (!dayMap[dateKey]) dayMap[dateKey] = { count: 0, input: 0, output: 0 };

      const messages = conversation.chat_messages || [];
      messages.forEach((msg: any) => {
        const text = msg.text || '';
        const tokens = estimateTokens(text);
        
        if (msg.sender === 'human') {
          usage.usage.tokens.input += tokens;
          dayMap[dateKey].input += tokens;
        } else {
          usage.usage.tokens.output += tokens;
          dayMap[dateKey].output += tokens;
        }
        dayMap[dateKey].count++;
        usage.usage.messages.count++;
      });
    });

    usage.period.start = minDate.toISOString();
    usage.period.end = maxDate.toISOString();
    usage.usage.messages.by_day = Object.entries(dayMap)
      .map(([date, stats]) => ({ date, ...stats }))
      .sort((a, b) => a.date.localeCompare(b.date));
      
    usage.usage.tokens.by_model['Claude (estimated)'] = {
      input: usage.usage.tokens.input,
      output: usage.usage.tokens.output
    };

    return usage;
  };

  // Checks only the fields the dashboard reads, so a wrong file fails here, not during rendering
  const isUsageReport = (json: any): json is UsageReport =>
    json &&
    typeof json === 'object' &&
    json.usage &&
    json.usage.tokens &&
    typeof json.usage.tokens.input === 'number' &&
    typeof json.usage.tokens.output === 'number' &&
    json.usage.tokens.by_model &&
    typeof json.usage.tokens.by_model === 'object' &&
    json.usage.messages &&
    Array.isArray(json.usage.messages.by_day) &&
    json.period &&
    typeof json.period.start === 'string' &&
    typeof json.period.end === 'string' &&
    json.plan &&
    typeof json.plan.price_usd === 'number';

  const processFile = async (file: File) => {
    setError(null);
    if (file.size > MAX_FILE_BYTES) {
      setError('That file is over 50 MB. Export a shorter date range, or use llm-usage scan.');
      return;
    }

    let json: any;
    try {
      json = JSON.parse(await file.text());
    } catch {
      setError("That file isn't valid JSON. Use usage_report.json from llm-usage scan, or conversations.json from Claude.ai.");
      return;
    }

    if (isUsageReport(json)) {
      onDataLoaded(json);
      return;
    }

    if (Array.isArray(json) && json.length > 0 && (json[0].uuid || json[0].chat_messages)) {
      const report = convertClaudeExportToUsageReport(json);
      if (report.usage.messages.count === 0) {
        setError('This Claude.ai export has no messages in it.');
        return;
      }
      onDataLoaded(report);
      return;
    }

    setError("This isn't a usage report or a Claude.ai export. Try usage_report.json from llm-usage scan.");
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragActive(false);
    if (e.dataTransfer.files && e.dataTransfer.files[0]) {
      processFile(e.dataTransfer.files[0]);
    }
  };

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    e.preventDefault();
    if (e.target.files && e.target.files[0]) {
      processFile(e.target.files[0]);
    }
  };

  const handleApiKeySubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (!apiKey.trim()) {
      setError('Please enter an API key');
      return;
    }

    if (!isValidOpenAIKey(apiKey)) {
      setError('Invalid API key format. OpenAI keys start with "sk-"');
      return;
    }

    const startDate = new Date(dateRange.start);
    const endDate = new Date(dateRange.end);
    if (Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime())) {
      setError('Pick a start and end date.');
      return;
    }
    if (endDate < startDate) {
      setError('The end date is before the start date.');
      return;
    }

    setIsLoading(true);

    try {
      // Test connection first
      const test = await testOpenAIConnection(apiKey);
      if (!test.success) {
        setError(test.error || 'Failed to connect to OpenAI');
        setIsLoading(false);
        return;
      }

      // Fetch usage data through the end of the chosen day
      const rangeEnd = new Date(endDate);
      rangeEnd.setHours(23, 59, 59, 999);

      const report = await fetchOpenAIUsage(apiKey, startDate, rangeEnd);
      onDataLoaded(report);
    } catch (err) {
      setError(`Failed to fetch usage: ${err instanceof Error ? err.message : 'Unknown error'}`);
    } finally {
      setIsLoading(false);
      setApiKey(''); // Clear API key from memory
    }
  };

  const goBack = () => {
    setError(null);
    if (view === 'anthropic-cli' || view === 'anthropic-web') {
      setView('anthropic-options');
    } else if (view === 'openai-manual') {
      setView('openai');
    } else {
      setView('main');
    }
  };

  // --- UI Components ---

  const OptionCard: React.FC<{
    icon: React.ReactNode;
    title: string;
    description: string;
    onClick: () => void;
    colorClass: string;
    bgHoverClass: string;
  }> = ({ icon, title, description, onClick, colorClass, bgHoverClass }) => (
    <button 
      onClick={onClick}
      className={`group relative flex flex-col items-start p-6 h-full rounded-2xl bg-slate-800/40 border border-white/5 
        hover:border-white/10 transition-all duration-300 hover:-translate-y-1 hover:shadow-xl hover:shadow-black/20
        ${bgHoverClass} text-left w-full overflow-hidden`}
    >
      <div className={`p-3 rounded-xl bg-slate-900/50 mb-4 ${colorClass} group-hover:scale-110 transition-transform duration-300`}>
        {icon}
      </div>
      <h3 className="text-lg font-bold text-white mb-2">{title}</h3>
      <p className="text-slate-400 text-sm leading-relaxed flex-1">{description}</p>
      <div className={`mt-6 flex items-center text-xs font-semibold uppercase tracking-wider ${colorClass} opacity-100 md:opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100 transition-opacity duration-300`}>
        Choose <ChevronRight className="w-4 h-4 ml-1" aria-hidden="true" />
      </div>
    </button>
  );

  return (
    <div className="flex flex-col items-center justify-center min-h-[85vh] p-4 font-sans">
      <div className="w-full max-w-5xl mx-auto">
        
        {/* Header Section */}
        <div className="text-center space-y-6 pt-8 mb-16 animate-in fade-in slide-in-from-top-8 duration-700">
          
          {/* Security Badge */}
          <div className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 text-xs font-medium mb-4 backdrop-blur-sm shadow-[0_0_15px_rgba(16,185,129,0.1)]">
            <ShieldCheck className="w-3 h-3" />
            <span>Privacy First: Analysis runs locally in your browser</span>
          </div>

          <h1 className="text-5xl md:text-6xl font-bold tracking-tight text-white drop-shadow-sm">
            Analyze your <span className="text-transparent bg-clip-text bg-gradient-to-r from-indigo-400 via-purple-400 to-pink-400">AI Spending</span>
          </h1>
          <p className="text-slate-400 text-lg max-w-2xl mx-auto leading-relaxed">
            Connect your usage data to visualize costs, find hidden patterns, and determine if you should switch to pay-as-you-go.
          </p>
        </div>

        {/* Main Interface Container */}
        <div className="relative min-h-[500px] w-full max-w-4xl mx-auto">
          {/* Content Wrapper with Animations */}
          <div className="bg-slate-900/60 backdrop-blur-xl border border-white/10 rounded-3xl p-8 md:p-12 shadow-2xl ring-1 ring-white/5 relative overflow-hidden transition-all duration-500">
            
            {/* Background Decor */}
            <div className="absolute top-0 right-0 w-[500px] h-[500px] bg-indigo-500/5 rounded-full blur-[100px] pointer-events-none -translate-y-1/2 translate-x-1/2"></div>
            
            {/* Navigation Header (if not on main) */}
            {view !== 'main' && (
              <div className="flex items-center gap-4 mb-8 animate-in fade-in slide-in-from-left-4 duration-300">
                <button
                  onClick={goBack}
                  aria-label="Back"
                  className="p-2 rounded-full hover:bg-white/5 text-slate-400 hover:text-white transition-colors"
                >
                  <ArrowLeft className="w-5 h-5" aria-hidden="true" />
                </button>
                <div className="h-6 w-px bg-white/10"></div>
                <h2 className="text-xl font-semibold text-white">
                  {view === 'anthropic-options' ? 'Anthropic / Claude' :
                   view === 'anthropic-cli' ? 'Claude Code (CLI)' :
                   view === 'anthropic-web' ? 'Claude.ai Web Export' :
                   view === 'openai' ? 'OpenAI / ChatGPT' :
                   view === 'openai-manual' ? 'Manual Usage Entry' : 'Upload File'}
                </h2>
              </div>
            )}

            {/* Error Message */}
            {error && (
              <div role="alert" className="mb-6 p-4 bg-red-500/10 border border-red-500/20 rounded-xl text-red-200 text-sm flex items-start gap-3">
                <AlertCircle className="w-5 h-5 text-red-400 shrink-0" aria-hidden="true" />
                <span className="flex-1">{error}</span>
                <button onClick={() => setError(null)} aria-label="Dismiss message" className="text-red-200 hover:text-white px-1">✕</button>
              </div>
            )}

            {/* VIEW: MAIN */}
            {view === 'main' && (
              <div className="space-y-6 animate-in fade-in slide-in-from-bottom-8 duration-500">
                {/* Local Server Banner on Home */}
                {localServerStatus === 'available' && (
                  <div className="p-5 bg-gradient-to-r from-emerald-500/10 to-teal-500/10 border border-emerald-500/30 rounded-xl shadow-lg">
                    <div className="flex items-center justify-between gap-4">
                      <div className="flex items-center gap-4">
                        <div className="p-3 bg-emerald-500/20 rounded-xl">
                          <Wifi className="w-7 h-7 text-emerald-400" />
                        </div>
                        <div>
                          <h3 className="text-lg font-bold text-white flex items-center gap-2">
                            Claude Code Data Ready
                            <span className="w-2 h-2 bg-emerald-400 rounded-full animate-pulse"></span>
                          </h3>
                          <p className="text-slate-400 text-sm">Local server detected - load your usage data instantly</p>
                        </div>
                      </div>
                      <button
                        onClick={loadFromLocalServer}
                        disabled={localServerLoading}
                        className="px-6 py-3 bg-emerald-500 hover:bg-emerald-400 text-white font-bold rounded-xl transition-all flex items-center gap-2 disabled:opacity-50 shadow-lg shadow-emerald-500/25 hover:shadow-emerald-500/40"
                      >
                        {localServerLoading ? (
                          <>
                            <Loader2 className="w-5 h-5 animate-spin" />
                            Loading...
                          </>
                        ) : (
                          <>
                            Analyze My Usage <ChevronRight className="w-5 h-5" />
                          </>
                        )}
                      </button>
                    </div>
                  </div>
                )}

                <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                <OptionCard 
                  icon={<Bot className="w-8 h-8" />}
                  title="Anthropic / Claude"
                  description="Analyze usage from Claude Code CLI sessions or your web chat history. No API key needed."
                  onClick={() => setView('anthropic-options')}
                  colorClass="text-orange-400"
                  bgHoverClass="hover:bg-orange-500/5"
                />
                <OptionCard 
                  icon={<Sparkles className="w-8 h-8" />}
                  title="OpenAI / ChatGPT"
                  description="Connect via API key to fetch detailed usage logs directly."
                  onClick={() => setView('openai')}
                  colorClass="text-emerald-400"
                  bgHoverClass="hover:bg-emerald-500/5"
                />
                <OptionCard
                  icon={<FileUp className="w-8 h-8" />}
                  title="Upload Report"
                  description="Already have a usage_report.json? Drop it here to visualize."
                  onClick={() => setView('upload')}
                  colorClass="text-blue-400"
                  bgHoverClass="hover:bg-blue-500/5"
                />
                </div>
              </div>
            )}

            {/* VIEW: ANTHROPIC OPTIONS */}
            {view === 'anthropic-options' && (
              <div className="space-y-6 animate-in fade-in slide-in-from-right-8 duration-500">
                {/* Help text */}
                <div className="p-4 bg-orange-500/5 border border-orange-500/20 rounded-xl">
                  <div className="flex items-start gap-3">
                    <Info className="w-5 h-5 text-orange-400 shrink-0 mt-0.5" />
                    <div className="text-sm text-slate-300">
                      <strong className="text-orange-400">Where's my Claude usage data?</strong>
                      <p className="mt-1 text-slate-400">Anthropic doesn't provide a public API for usage stats yet. Choose how you use Claude to get your data:</p>
                    </div>
                  </div>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                  <OptionCard
                    icon={<Terminal className="w-8 h-8" />}
                    title="Claude Code (CLI)"
                    description="Using Claude Code in VS Code, Cursor, or terminal? We can scan your local session files."
                    onClick={() => setView('anthropic-cli')}
                    colorClass="text-indigo-400"
                    bgHoverClass="hover:bg-indigo-500/5"
                  />
                  <OptionCard
                    icon={<Globe className="w-8 h-8" />}
                    title="Claude.ai (Web)"
                    description="Using claude.ai in your browser? Export your conversation history."
                    onClick={() => setView('anthropic-web')}
                    colorClass="text-purple-400"
                    bgHoverClass="hover:bg-purple-500/5"
                  />
                </div>

                {/* Quick links */}
                <div className="flex items-center justify-center gap-6 pt-4 text-xs">
                  <a
                    href="https://console.anthropic.com/settings/usage"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-slate-500 hover:text-slate-300 flex items-center gap-1"
                  >
                    <ExternalLink className="w-3 h-3" />
                    Anthropic Console (API users)
                  </a>
                  <a
                    href="https://support.anthropic.com/en/articles/9362598-how-do-i-export-my-conversations"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-slate-500 hover:text-slate-300 flex items-center gap-1"
                  >
                    <HelpCircle className="w-3 h-3" />
                    Export help docs
                  </a>
                </div>
              </div>
            )}

            {/* VIEW: CLI SETUP */}
            {view === 'anthropic-cli' && (
              <div className="space-y-6 animate-in fade-in slide-in-from-right-8 duration-500">
                {/* Local Server Detection Banner */}
                {localServerStatus === 'available' && (
                  <div className="p-4 bg-emerald-500/10 border border-emerald-500/30 rounded-xl shadow-lg shadow-emerald-500/5">
                    <div className="flex items-center justify-between gap-4">
                      <div className="flex items-center gap-3">
                        <div className="p-2 bg-emerald-500/20 rounded-lg">
                          <Wifi className="w-5 h-5 text-emerald-400" />
                        </div>
                        <div>
                          <h4 className="text-emerald-400 font-semibold flex items-center gap-2">
                            Local Server Detected
                            <span className="w-2 h-2 bg-emerald-400 rounded-full animate-pulse"></span>
                          </h4>
                          <p className="text-sm text-slate-400">Connected to localhost:3456 - your usage data is ready!</p>
                        </div>
                      </div>
                      <button
                        onClick={loadFromLocalServer}
                        disabled={localServerLoading}
                        className="px-5 py-2.5 bg-emerald-500 hover:bg-emerald-400 text-white font-bold rounded-lg transition-all flex items-center gap-2 disabled:opacity-50 shadow-lg shadow-emerald-500/20"
                      >
                        {localServerLoading ? (
                          <>
                            <Loader2 className="w-4 h-4 animate-spin" />
                            Loading...
                          </>
                        ) : (
                          <>
                            Load Data <ChevronRight className="w-4 h-4" />
                          </>
                        )}
                      </button>
                    </div>
                  </div>
                )}

                {localServerStatus === 'unavailable' && (
                  <div className="p-5 bg-gradient-to-r from-indigo-500/10 to-purple-500/10 border border-indigo-500/30 rounded-xl">
                    <div className="flex items-start gap-4">
                      <div className="p-2.5 bg-indigo-500/20 rounded-lg shrink-0">
                        <Server className="w-6 h-6 text-indigo-400" />
                      </div>
                      <div className="flex-1">
                        <h4 className="text-white font-bold text-lg mb-2">Quick Setup (Recommended)</h4>
                        <ol className="space-y-3 text-sm text-slate-300 list-decimal list-inside">
                          <li>
                            One time only, in the project folder:
                            <code className="block mt-1 bg-slate-900 rounded-lg p-2 font-mono text-emerald-400">npm run setup</code>
                          </li>
                          <li>
                            Then start the local server:
                            <code className="block mt-1 bg-slate-900 rounded-lg p-2 font-mono text-emerald-400">llm-usage serve</code>
                          </li>
                        </ol>
                        <p className="text-xs text-slate-500 mt-3">
                          Leave that terminal open. This page detects the server and loads your data.
                        </p>
                      </div>
                      <button
                        onClick={refreshLocalServerCheck}
                        className="p-2 hover:bg-slate-700 rounded-lg transition-colors text-slate-400 hover:text-white shrink-0"
                        aria-label="Check again for the local server"
                        title="Check again"
                      >
                        <RefreshCw className="w-5 h-5" aria-hidden="true" />
                      </button>
                    </div>
                  </div>
                )}

                {localServerStatus === 'checking' && (
                  <div className="p-4 bg-slate-800/50 border border-slate-700 rounded-xl">
                    <div className="flex items-center gap-3">
                      <Loader2 className="w-5 h-5 text-slate-400 animate-spin" />
                      <span className="text-slate-400">Checking for local server...</span>
                    </div>
                  </div>
                )}

                {/* Security Note */}
                <div className="p-4 rounded-xl bg-emerald-500/5 border border-emerald-500/10 flex gap-3">
                  <Lock className="w-5 h-5 text-emerald-400 shrink-0" />
                  <div className="text-xs text-slate-300 leading-relaxed">
                    <strong className="text-emerald-400 block mb-1">100% Private & Secure</strong>
                    Everything runs locally on your machine. No code, prompts, or data is sent to any server.
                  </div>
                </div>

                {/* Alternative: Export file method */}
                <details className="group">
                  <summary className="cursor-pointer p-4 bg-slate-800/30 border border-slate-700/50 rounded-xl hover:bg-slate-800/50 transition-colors list-none">
                    <div className="flex items-center gap-3">
                      <FileJson className="w-5 h-5 text-slate-400" />
                      <div className="flex-1">
                        <span className="text-slate-300 font-medium">Alternative: Export to JSON file</span>
                        <p className="text-xs text-slate-500 mt-0.5">Use <code className="bg-slate-800 px-1.5 py-0.5 rounded">llm-usage scan</code> instead</p>
                      </div>
                      <ChevronRight className="w-4 h-4 text-slate-500 group-open:rotate-90 transition-transform" />
                    </div>
                  </summary>
                  <div className="mt-4 space-y-3 pl-4 border-l-2 border-slate-700/50">
                    <div className="flex items-center gap-4 p-3 rounded-lg bg-slate-800/30 border border-slate-700/50">
                      <div className="w-6 h-6 rounded-full bg-indigo-500/20 text-indigo-400 flex items-center justify-center font-bold text-xs">1</div>
                      <p className="text-sm text-slate-300">Run <code className="bg-slate-800 px-1.5 py-0.5 rounded text-emerald-400">llm-usage scan</code> in terminal</p>
                    </div>
                    <div className="flex items-center gap-4 p-3 rounded-lg bg-slate-800/30 border border-slate-700/50">
                      <div className="w-6 h-6 rounded-full bg-indigo-500/20 text-indigo-400 flex items-center justify-center font-bold text-xs">2</div>
                      <p className="text-sm text-slate-300">Drag the generated <code className="bg-slate-800 px-1.5 py-0.5 rounded">usage_report.json</code> below</p>
                    </div>
                  </div>
                </details>
              </div>
            )}

            {/* VIEW: OPENAI */}
            {view === 'openai' && (
              <div className="space-y-6 animate-in fade-in slide-in-from-right-8 duration-500">
                {/* Help text */}
                <div className="p-4 bg-emerald-500/5 border border-emerald-500/20 rounded-xl">
                  <div className="flex items-start gap-3">
                    <Info className="w-5 h-5 text-emerald-400 shrink-0 mt-0.5" />
                    <div className="text-sm text-slate-300">
                      <strong className="text-emerald-400">Getting OpenAI usage data</strong>
                      <p className="mt-1 text-slate-400">For API users, we can fetch your usage automatically. ChatGPT Plus/Pro users can view usage on the platform.</p>
                    </div>
                  </div>
                </div>

                {/* API Key Form */}
                <div className="bg-slate-800/30 border border-slate-700/50 rounded-xl p-6">
                  <h3 className="text-lg font-semibold text-white mb-4 flex items-center gap-2">
                    <Key className="w-5 h-5 text-emerald-400" />
                    API Users: Auto-fetch Usage
                  </h3>
                  <form onSubmit={handleApiKeySubmit} className="space-y-4">
                    <div className="relative group">
                      <label htmlFor="openai-key" className="block text-xs text-slate-400 mb-1">
                        OpenAI admin key (usage data needs an admin key, not a regular API key)
                      </label>
                      <input
                        id="openai-key"
                        type="password"
                        value={apiKey}
                        onChange={(e) => setApiKey(e.target.value)}
                        placeholder="sk-..."
                        autoComplete="off"
                        spellCheck={false}
                        disabled={isLoading}
                        className="w-full bg-slate-950/50 border border-slate-700 rounded-xl px-4 py-3 text-white placeholder:text-slate-600 focus:ring-2 focus:ring-emerald-500/50 focus:border-emerald-500/50 outline-none transition-all disabled:opacity-50"
                      />
                    </div>

                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <label htmlFor="openai-start" className="text-xs text-slate-500 mb-1 block flex items-center gap-1">
                          <Calendar className="w-3 h-3" aria-hidden="true" /> Start Date
                        </label>
                        <input
                          id="openai-start"
                          type="date"
                          value={dateRange.start}
                          onChange={(e) => setDateRange({ ...dateRange, start: e.target.value })}
                          disabled={isLoading}
                          className="w-full bg-slate-950/50 border border-slate-700 rounded-lg px-3 py-2 text-white text-sm focus:ring-2 focus:ring-emerald-500/50 focus:border-emerald-500/50 outline-none disabled:opacity-50"
                        />
                      </div>
                      <div>
                        <label htmlFor="openai-end" className="text-xs text-slate-500 mb-1 block flex items-center gap-1">
                          <Calendar className="w-3 h-3" aria-hidden="true" /> End Date
                        </label>
                        <input
                          id="openai-end"
                          type="date"
                          value={dateRange.end}
                          onChange={(e) => setDateRange({ ...dateRange, end: e.target.value })}
                          disabled={isLoading}
                          className="w-full bg-slate-950/50 border border-slate-700 rounded-lg px-3 py-2 text-white text-sm focus:ring-2 focus:ring-emerald-500/50 focus:border-emerald-500/50 outline-none disabled:opacity-50"
                        />
                      </div>
                    </div>

                    <div className="flex items-center justify-between">
                      <p className="text-xs text-slate-500 flex items-center gap-1">
                        <EyeOff className="w-3 h-3" />
                        Key used once, never stored
                      </p>
                      <a
                        href="https://platform.openai.com/api-keys"
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-xs text-emerald-400 hover:text-emerald-300 flex items-center gap-1"
                      >
                        Find or create keys <ExternalLink className="w-3 h-3" aria-hidden="true" />
                      </a>
                    </div>

                    <button
                      type="submit"
                      disabled={isLoading || !apiKey}
                      className="w-full py-3 bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-500 hover:to-teal-500 text-white rounded-xl font-bold shadow-lg shadow-emerald-500/20 transition-all active:scale-[0.98] flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      {isLoading ? (
                        <>
                          <Loader2 className="w-4 h-4 animate-spin" />
                          Fetching Usage...
                        </>
                      ) : (
                        <>
                          Fetch Usage Data <ChevronRight className="w-4 h-4" />
                        </>
                      )}
                    </button>
                  </form>
                </div>

                {/* Alternative: View on Platform */}
                <div className="bg-slate-800/30 border border-slate-700/50 rounded-xl p-6">
                  <h3 className="text-lg font-semibold text-white mb-3 flex items-center gap-2">
                    <Globe className="w-5 h-5 text-purple-400" />
                    ChatGPT Plus/Pro Users
                  </h3>
                  <p className="text-sm text-slate-400 mb-4">
                    ChatGPT subscription usage is shown on the OpenAI platform. You can view your limits but detailed token counts aren't exported.
                  </p>
                  <div className="flex gap-3">
                    <a
                      href="https://platform.openai.com/usage"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex-1 py-2.5 px-4 bg-slate-700 hover:bg-slate-600 text-white rounded-lg text-sm font-medium flex items-center justify-center gap-2 transition-colors"
                    >
                      View Usage Dashboard <ExternalLink className="w-3.5 h-3.5" />
                    </a>
                    <a
                      href="https://chatgpt.com/settings"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="py-2.5 px-4 bg-slate-700 hover:bg-slate-600 text-white rounded-lg text-sm font-medium flex items-center justify-center gap-2 transition-colors"
                    >
                      ChatGPT Settings <ExternalLink className="w-3.5 h-3.5" />
                    </a>
                  </div>
                </div>
              </div>
            )}

            {/* VIEW: ANTHROPIC WEB - Step by step guide */}
            {view === 'anthropic-web' && (
              <div className="space-y-6 animate-in fade-in slide-in-from-right-8 duration-500">
                <div className="bg-purple-500/5 border border-purple-500/20 rounded-xl p-6">
                  <h3 className="text-lg font-semibold text-white mb-4 flex items-center gap-2">
                    <Download className="w-5 h-5 text-purple-400" />
                    How to Export from Claude.ai
                  </h3>

                  <div className="space-y-4">
                    <div className="flex gap-4 p-3 bg-slate-800/50 rounded-lg">
                      <div className="w-7 h-7 rounded-full bg-purple-500/20 text-purple-400 flex items-center justify-center font-bold text-sm shrink-0">1</div>
                      <div className="flex-1">
                        <p className="text-sm text-slate-300">Go to <strong className="text-white">claude.ai</strong> and sign in to your account</p>
                      </div>
                      <a
                        href="https://claude.ai"
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-purple-400 hover:text-purple-300 shrink-0"
                      >
                        <ExternalLink className="w-4 h-4" />
                      </a>
                    </div>

                    <div className="flex gap-4 p-3 bg-slate-800/50 rounded-lg">
                      <div className="w-7 h-7 rounded-full bg-purple-500/20 text-purple-400 flex items-center justify-center font-bold text-sm shrink-0">2</div>
                      <div className="flex-1">
                        <p className="text-sm text-slate-300">Click your <strong className="text-white">profile icon</strong> (bottom left) → <strong className="text-white">Settings</strong></p>
                      </div>
                    </div>

                    <div className="flex gap-4 p-3 bg-slate-800/50 rounded-lg">
                      <div className="w-7 h-7 rounded-full bg-purple-500/20 text-purple-400 flex items-center justify-center font-bold text-sm shrink-0">3</div>
                      <div className="flex-1">
                        <p className="text-sm text-slate-300">Go to <strong className="text-white">Account</strong> tab → Scroll to <strong className="text-white">"Export Data"</strong></p>
                      </div>
                    </div>

                    <div className="flex gap-4 p-3 bg-slate-800/50 rounded-lg">
                      <div className="w-7 h-7 rounded-full bg-purple-500/20 text-purple-400 flex items-center justify-center font-bold text-sm shrink-0">4</div>
                      <div className="flex-1">
                        <p className="text-sm text-slate-300">Click <strong className="text-white">"Export"</strong> → You'll receive an email with a download link</p>
                      </div>
                    </div>

                    <div className="flex gap-4 p-3 bg-slate-800/50 rounded-lg">
                      <div className="w-7 h-7 rounded-full bg-purple-500/20 text-purple-400 flex items-center justify-center font-bold text-sm shrink-0">5</div>
                      <div className="flex-1">
                        <p className="text-sm text-slate-300">Download the ZIP, extract it, and upload <strong className="text-white">conversations.json</strong> below</p>
                      </div>
                    </div>
                  </div>

                  <div className="mt-4 p-3 bg-amber-500/10 border border-amber-500/20 rounded-lg flex items-start gap-3">
                    <AlertCircle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
                    <p className="text-xs text-slate-400">
                      <strong className="text-amber-400">Note:</strong> Export may take a few minutes. Token counts are estimated from message lengths since Claude.ai doesn't provide exact counts.
                    </p>
                  </div>
                </div>

                {/* Plan Selector */}
                <div className="bg-slate-800/30 border border-slate-700/50 rounded-xl p-6">
                  <h3 className="text-lg font-semibold text-white mb-3 flex items-center gap-2">
                    <DollarSign className="w-5 h-5 text-purple-400" />
                    What's your Claude plan?
                  </h3>
                  <p className="text-sm text-slate-400 mb-4">
                    Select your subscription to get accurate cost analysis.
                  </p>
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                    {PLAN_KEYS.map((plan) => (
                      <button
                        key={plan}
                        type="button"
                        aria-pressed={selectedPlan === plan}
                        onClick={() => setSelectedPlan(plan)}
                        className={`p-4 rounded-xl border-2 transition-all text-left ${
                          selectedPlan === plan
                            ? 'border-purple-500 bg-purple-500/10'
                            : 'border-slate-700 hover:border-slate-600 bg-slate-800/50'
                        }`}
                      >
                        <div className="font-semibold text-white">{plan}</div>
                        <div className={`text-2xl font-bold mt-1 ${
                          selectedPlan === plan ? 'text-purple-400' : 'text-slate-300'
                        }`}>
                          ${PLANS[plan].price}<span className="text-sm font-normal text-slate-500">/mo</span>
                        </div>
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            )}

            {/* VIEW: UPLOAD / DROPZONE */}
            {(view === 'upload' || view === 'anthropic-web' || view === 'anthropic-cli') && (
              <div className={`${view === 'anthropic-web' ? 'mt-6' : 'mt-8'} animate-in fade-in slide-in-from-bottom-4 duration-700 delay-200`}>
                <div className="flex items-center gap-4 mb-4">
                  <div className="h-px bg-slate-800 flex-1"></div>
                  <span className="text-xs font-bold text-slate-500 uppercase tracking-widest">
                    {view === 'anthropic-cli' ? 'Step 2: Upload Report' :
                     view === 'anthropic-web' ? 'Last step: Upload File' : 'Upload File'}
                  </span>
                  <div className="h-px bg-slate-800 flex-1"></div>
                </div>

                <div 
                  className={`relative w-full border-2 border-dashed rounded-2xl p-10 transition-all duration-300 ease-out flex flex-col items-center justify-center text-center group
                    ${dragActive 
                      ? 'border-indigo-500 bg-indigo-500/10 scale-[1.01] shadow-2xl shadow-indigo-500/20' 
                      : 'border-slate-700 hover:border-slate-500 hover:bg-slate-800/30'
                    }
                  `}
                  onDragEnter={handleDrag}
                  onDragLeave={handleDrag}
                  onDragOver={handleDrag}
                  onDrop={handleDrop}
                >
                  <input
                    ref={fileInputRef}
                    type="file"
                    id="file-upload"
                    className="sr-only"
                    tabIndex={-1}
                    aria-hidden="true"
                    onChange={handleChange}
                    accept=".json,application/json"
                  />

                  <div className={`p-4 rounded-xl mb-4 transition-all duration-300 ${dragActive ? 'bg-indigo-500 text-white' : 'bg-slate-800 text-slate-400 group-hover:text-white group-hover:bg-slate-700'}`} aria-hidden="true">
                    <Upload className="w-8 h-8" />
                  </div>

                  <h3 className="text-lg font-bold text-white mb-1">
                    {dragActive ? 'Drop to upload' : 'Drop your file here'}
                  </h3>
                  <p className="text-slate-500 text-sm mb-6 max-w-sm mx-auto">
                    {view === 'anthropic-web'
                      ? 'Upload conversations.json. It is read in your browser and not sent anywhere.'
                      : 'Accepts usage_report.json or a Claude.ai export. Read in your browser, not sent anywhere.'}
                  </p>

                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    className="px-6 py-2.5 bg-slate-200 hover:bg-white text-slate-900 font-semibold rounded-lg cursor-pointer transition-all shadow-lg hover:shadow-xl active:scale-95 focus-visible:ring-2 focus-visible:ring-indigo-400 focus-visible:ring-offset-2 focus-visible:ring-offset-slate-900"
                  >
                    Choose file
                  </button>
                </div>
              </div>
            )}

          </div>

          {/* Demo Button Footer */}
          <div className="flex justify-center mt-8">
             <button 
              onClick={onLoadDemo}
              className="group flex items-center gap-2 px-5 py-2 text-slate-500 hover:text-indigo-300 transition-all text-sm font-medium rounded-full hover:bg-slate-800/50"
            >
              <Play className="w-3 h-3 group-hover:fill-current transition-colors" />
              Try with Demo Data
            </button>
          </div>

        </div>
      </div>
    </div>
  );
};

export default Uploader;