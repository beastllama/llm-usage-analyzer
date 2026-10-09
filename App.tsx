import React, { useState, useEffect, useCallback, useRef } from 'react';
import Uploader, { StartNotice } from './components/Uploader';
import AnalysisDashboard, { LiveStatus } from './components/AnalysisDashboard';
import HistoryView from './components/HistoryView';
import ErrorBoundary from './components/ErrorBoundary';
import { UsageReport, StoredReport } from './types';
import { MOCK_DATA } from './constants';
import { Activity, History, ChevronDown, Trash2, TrendingUp, Loader2 } from 'lucide-react';
import { storageService } from './services/storageService';
import { servedByCli, fetchLocalUsage, localServerIsUp } from './services/localServer';
import { safeSession } from './services/safeStorage';
import { plain } from './services/format';

type ViewMode = 'uploader' | 'dashboard' | 'trends';

const HEALTH_EVERY_MS = 10_000;
/** The analyzer counts as stopped after this many failed checks in a row. One slow answer is not an outage. */
const FAILS_BEFORE_STOPPED = 2;

interface Toast {
  message: string;
  undo?: () => void;
}

const TITLES: Record<ViewMode, string> = {
  uploader: 'LLM Usage Analyzer',
  dashboard: 'Your answer · LLM Usage Analyzer',
  trends: 'Trends · LLM Usage Analyzer',
};

const App: React.FC = () => {
  const [data, setData] = useState<UsageReport | null>(null);
  const [savedReports, setSavedReports] = useState<StoredReport[]>([]);
  const [currentReportId, setCurrentReportId] = useState<string | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const [viewMode, setViewMode] = useState<ViewMode>('uploader');
  const [isLiveData, setIsLiveData] = useState(false);
  const [live, setLive] = useState<LiveStatus>({ connected: false, updatedAt: null });
  // When the CLI serves this page, the data is read straight away: no clicks needed
  const [readingLocal, setReadingLocal] = useState(servedByCli);
  const [startNotice, setStartNotice] = useState<StartNotice | null>(null);
  const [toast, setToast] = useState<Toast | null>(null);
  // Changing this key puts the screen back to a clean state after an error
  const [boundaryKey, setBoundaryKey] = useState(0);
  const historyRef = useRef<HTMLDivElement>(null);
  const historyButtonRef = useRef<HTMLButtonElement>(null);
  // A late answer from the analyzer must not revive a screen the person already left
  const liveRun = useRef(0);

  // Initialize storage and restore session state on mount
  useEffect(() => {
    const reports = storageService.getReports();
    setSavedReports(reports);

    // The CLI-served page loads live data instead (see below)
    if (servedByCli) return;

    // Restore session state (survives browser refresh)
    const savedViewMode = safeSession.get('viewMode');
    const savedReportId = safeSession.get('currentReportId');

    if (savedViewMode && savedReportId) {
      const report = reports.find(r => r.id === savedReportId);
      if (report) {
        setData(report.report);
        setCurrentReportId(savedReportId);
        setViewMode(savedViewMode === 'trends' ? 'trends' : 'dashboard');
      }
    } else if (savedViewMode === 'trends' && reports.length >= 2) {
      setViewMode('trends');
    }
  }, []);

  // Persist session state on changes
  useEffect(() => {
    safeSession.set('viewMode', viewMode);
    if (currentReportId) safeSession.set('currentReportId', currentReportId);
    else safeSession.remove('currentReportId');
  }, [viewMode, currentReportId]);

  // The tab title says where you are
  useEffect(() => { document.title = TITLES[viewMode]; }, [viewMode]);

  // A message that clears itself
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), toast.undo ? 8000 : 5000);
    return () => clearTimeout(t);
  }, [toast]);

  // Close the Saved list with Escape or a click elsewhere
  useEffect(() => {
    if (!showHistory) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { setShowHistory(false); historyButtonRef.current?.focus(); }
    };
    const onPointer = (e: MouseEvent) => {
      if (historyRef.current && !historyRef.current.contains(e.target as Node)) setShowHistory(false);
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('mousedown', onPointer);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('mousedown', onPointer);
    };
  }, [showHistory]);

  // While showing live data, check now and then that the analyzer is still running
  useEffect(() => {
    if (!isLiveData) return;
    let failures = 0;
    let cancelled = false;
    const check = async () => {
      const up = await localServerIsUp(5000);
      if (cancelled) return;
      failures = up ? 0 : failures + 1;
      if (up || failures >= FAILS_BEFORE_STOPPED) setLive((l) => ({ ...l, connected: up }));
    };
    const interval = setInterval(check, HEALTH_EVERY_MS);
    return () => { cancelled = true; clearInterval(interval); };
  }, [isLiveData]);

  const handleLiveRefresh = useCallback(async (): Promise<boolean> => {
    if (!isLiveData) return false;
    const run = liveRun.current;
    const result = await fetchLocalUsage();
    if (run !== liveRun.current) return false;
    if (result.ok === false) {
      if (result.reason === 'stopped') setLive((l) => ({ ...l, connected: false }));
      return false;
    }
    setData(result.report);
    setLive({ connected: true, updatedAt: Date.now() });
    return true;
  }, [isLiveData]);

  const handleDataLoaded = useCallback((uploadedData: UsageReport, fromLiveServer: boolean = false) => {
    liveRun.current++;
    setBoundaryKey((k) => k + 1);
    setData(uploadedData);
    setViewMode('dashboard');
    setIsLiveData(fromLiveServer);
    setStartNotice(null);
    if (fromLiveServer) setLive({ connected: true, updatedAt: Date.now() });

    // Live data is not saved, because it changes. Reports opened from history are not saved again.
    if (fromLiveServer || currentReportId) return;

    // Empty reports are not saved
    const total = uploadedData.usage.tokens.input + uploadedData.usage.tokens.output;
    if (total === 0 && uploadedData.usage.messages.count === 0) return;

    const duplicate = storageService.findDuplicateReport(uploadedData);
    if (duplicate) {
      // Update the saved copy, so a reload shows the same numbers the user just saw
      if (storageService.updateReportData(duplicate.id, uploadedData)) setCurrentReportId(duplicate.id);
    } else {
      const saved = storageService.saveReport(uploadedData);
      if (saved) setCurrentReportId(saved.id);
      else setToast({ message: "This report couldn't be kept in your browser (storage is full or blocked). It still shows for this visit." });
    }
    setSavedReports(storageService.getReports());
  }, [currentReportId]);

  // Served by the CLI: read the local history on arrival
  useEffect(() => {
    if (!servedByCli) return;
    let cancelled = false;
    (async () => {
      const result = await fetchLocalUsage();
      if (cancelled) return;
      if (result.ok) handleDataLoaded(result.report, true);
      else setStartNotice({ kind: result.reason === 'no-history' ? 'no-history' : 'error', text: result.message });
      setReadingLocal(false);
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleLoadDemo = () => {
    liveRun.current++;
    setBoundaryKey((k) => k + 1);
    setData(MOCK_DATA);
    setCurrentReportId(null); // Demo data is not saved
    setIsLiveData(false);
    setViewMode('dashboard');
  };

  const handleReset = () => {
    liveRun.current++;
    setBoundaryKey((k) => k + 1);
    setData(null);
    setCurrentReportId(null);
    setIsLiveData(false);
    setStartNotice(null);
    setViewMode('uploader');
    safeSession.remove('viewMode');
    safeSession.remove('currentReportId');
  };

  const handleLoadFromHistory = (stored: StoredReport) => {
    liveRun.current++;
    setBoundaryKey((k) => k + 1);
    setData(stored.report);
    setCurrentReportId(stored.id);
    setIsLiveData(false);
    setShowHistory(false);
    setViewMode('dashboard');
  };

  const handleDeleteFromHistory = (stored: StoredReport) => {
    const before = storageService.getReports();
    storageService.deleteReport(stored.id);
    setSavedReports(storageService.getReports());
    setToast({
      message: `Deleted ${plain(stored.name)}.`,
      undo: () => {
        storageService.setReports(before);
        setSavedReports(storageService.getReports());
        setToast(null);
      },
    });
    if (currentReportId === stored.id) handleReset();
  };

  const handleDeleteAll = () => {
    const before = storageService.getReports();
    storageService.clearHistory();
    setSavedReports([]);
    setShowHistory(false);
    setToast({
      message: `Deleted ${before.length} saved reports.`,
      undo: () => {
        storageService.setReports(before);
        setSavedReports(storageService.getReports());
        setToast(null);
      },
    });
    if (currentReportId) handleReset();
  };

  const formatDate = (dateStr: string) =>
    new Date(dateStr).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

  return (
    <div className="min-h-screen bg-[#0B0C15] text-slate-200 font-sans selection:bg-indigo-500/30 relative">
      {/* Soft background glow. Still, so nothing moves on its own. */}
      <div className="fixed inset-0 pointer-events-none" aria-hidden="true">
        <div className="absolute top-[-10%] left-[-10%] w-[40%] h-[40%] bg-indigo-900/20 rounded-full blur-[120px] mix-blend-screen"></div>
        <div className="absolute bottom-[-10%] right-[-10%] w-[40%] h-[40%] bg-purple-900/20 rounded-full blur-[120px] mix-blend-screen"></div>
      </div>

      <nav className="border-b border-white/10 bg-slate-950/80 backdrop-blur-xl sticky top-0 z-50">
        <div className="max-w-7xl mx-auto px-4 md:px-6 min-h-16 py-2 flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 bg-linear-to-br from-indigo-500 via-purple-500 to-pink-500 rounded-xl flex items-center justify-center" aria-hidden="true">
              <Activity className="w-5 h-5 text-white" />
            </div>
            <span className="font-bold text-lg tracking-tight text-white/90">Usage<span className="text-indigo-300">Analyzer</span></span>
          </div>
          <div className="flex items-center gap-1 md:gap-3">
            {savedReports.length >= 2 && viewMode !== 'trends' && (
              <button
                onClick={() => setViewMode('trends')}
                className="flex items-center gap-2 text-sm font-medium text-slate-200 hover:text-white px-3 min-h-11 rounded-full hover:bg-white/10"
              >
                <TrendingUp className="w-4 h-4" aria-hidden="true" />
                <span>Trends</span>
              </button>
            )}

            {savedReports.length > 0 && viewMode !== 'trends' && (
              <div className="relative" ref={historyRef}>
                <button
                  ref={historyButtonRef}
                  onClick={() => setShowHistory(!showHistory)}
                  aria-expanded={showHistory}
                  aria-controls="saved-reports"
                  className="flex items-center gap-2 text-sm font-medium text-slate-200 hover:text-white px-3 min-h-11 rounded-full hover:bg-white/10"
                >
                  <History className="w-4 h-4" aria-hidden="true" />
                  <span>Saved ({savedReports.length})</span>
                  <ChevronDown className={`w-4 h-4 transition-transform ${showHistory ? 'rotate-180' : ''}`} aria-hidden="true" />
                </button>

                {showHistory && (
                  <div id="saved-reports" className="absolute right-0 mt-2 w-[min(20rem,calc(100vw-2rem))] bg-slate-900 border border-white/15 rounded-xl shadow-xl z-50 overflow-hidden">
                    <ul className="max-h-64 overflow-y-auto">
                      {savedReports.map((stored) => (
                        <li key={stored.id} className="flex items-center hover:bg-white/5">
                          <button
                            onClick={() => handleLoadFromHistory(stored)}
                            className={`flex-1 min-w-0 px-4 py-3 min-h-11 text-left ${
                              currentReportId === stored.id ? 'border-l-2 border-indigo-400 bg-indigo-500/10' : ''
                            }`}
                          >
                            <div className="text-sm font-medium text-white truncate">{plain(stored.name)}</div>
                            <div className="text-xs text-slate-300">Saved {formatDate(stored.savedAt)}</div>
                          </button>
                          <button
                            onClick={() => handleDeleteFromHistory(stored)}
                            aria-label={`Delete ${plain(stored.name)}`}
                            className="min-w-11 min-h-11 flex items-center justify-center text-slate-300 hover:text-red-300"
                          >
                            <Trash2 className="w-4 h-4" aria-hidden="true" />
                          </button>
                        </li>
                      ))}
                    </ul>
                    <button
                      onClick={handleDeleteAll}
                      className="w-full px-4 min-h-11 text-left text-sm text-slate-200 hover:bg-white/5 border-t border-white/10"
                    >
                      Delete all saved reports
                    </button>
                  </div>
                )}
              </div>
            )}

            <a
              href="https://github.com/beastllama/llm-usage-analyzer"
              target="_blank"
              rel="noopener noreferrer"
              className="text-sm font-medium text-slate-200 hover:text-white px-3 min-h-11 inline-flex items-center rounded-full hover:bg-white/10"
            >
              GitHub<span className="sr-only"> (opens in a new tab)</span>
            </a>
          </div>
        </div>
      </nav>

      <main className="relative z-10">
        <ErrorBoundary
          key={boundaryKey}
          onReset={handleReset}
          resetLabel="Back to start"
          extraLabel="Delete saved reports and start over"
          onExtra={() => { storageService.clearHistory(); setSavedReports([]); }}
        >
          {viewMode === 'uploader' && readingLocal && (
            <div role="status" className="max-w-md mx-auto text-center py-24 px-4 space-y-3">
              <Loader2 className="w-8 h-8 mx-auto text-indigo-300 motion-safe:animate-spin" aria-hidden="true" />
              <p className="text-slate-200">Reading your Claude Code history…</p>
              <p className="text-sm text-slate-300">A big history can take a few seconds.</p>
            </div>
          )}
          {viewMode === 'uploader' && !readingLocal && (
            <Uploader onDataLoaded={handleDataLoaded} onLoadDemo={handleLoadDemo} initialNotice={startNotice} />
          )}
          {viewMode === 'dashboard' && data && (
            <AnalysisDashboard
              data={data}
              onReset={handleReset}
              isLiveData={isLiveData}
              live={live}
              onLiveRefresh={handleLiveRefresh}
            />
          )}
          {viewMode === 'trends' && (
            <HistoryView reports={savedReports} onBack={() => setViewMode(data ? 'dashboard' : 'uploader')} />
          )}
        </ErrorBoundary>
      </main>

      {toast && (
        <div role="status" className="fixed bottom-4 left-1/2 -translate-x-1/2 z-50 max-w-[calc(100vw-2rem)] bg-slate-800 border border-white/20 text-slate-100 text-sm rounded-xl shadow-xl px-4 py-2 flex items-center gap-3">
          <span>{toast.message}</span>
          {toast.undo && (
            <button onClick={toast.undo} className="font-semibold text-indigo-200 hover:text-white underline min-h-11 px-1">Undo</button>
          )}
        </div>
      )}
    </div>
  );
};

export default App;
