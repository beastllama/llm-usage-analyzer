import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import Uploader, { StartNotice } from './components/Uploader';
import AnalysisDashboard, { LiveStatus, RefreshResult } from './components/AnalysisDashboard';
import HistoryView from './components/HistoryView';
import ErrorBoundary from './components/ErrorBoundary';
import { UsageReport, StoredReport } from './types';
import { MOCK_DATA } from './constants';
import { Activity, History, ChevronDown, Trash2, TrendingUp, Loader2, X } from 'lucide-react';
import { storageService } from './services/storageService';
import { servedByCli, fetchLocalUsage, localServerIsUp } from './services/localServer';
import { safeSession } from './services/safeStorage';
import { calculateMonthlyTrends } from './services/trendService';
import { formatDate, plain, plural } from './services/format';

type ViewMode = 'uploader' | 'dashboard' | 'trends';

const HEALTH_EVERY_MS = 10_000;
/** The analyzer counts as stopped after this many failed checks in a row. One slow answer is not an outage. */
const FAILS_BEFORE_STOPPED = 2;
/** After a delete, further deletes wait this long. A double-click would otherwise hit the next row, which slides under the pointer. */
const DELETE_PAUSE_MS = 700;
const UNDO_MS = 10_000;
const NOTE_MS = 5_000;

interface Toast {
  message: string;
  undo?: () => void;
}

const TITLES: Record<ViewMode, string> = {
  uploader: 'LLM Usage Analyzer',
  dashboard: 'Your answer · LLM Usage Analyzer',
  trends: 'Trends · LLM Usage Analyzer',
};

interface Restored {
  reports: StoredReport[];
  data: UsageReport | null;
  reportId: string | null;
  view: ViewMode;
}

/** What the screen shows when the page opens: the saved list, and where the person was before a reload. Read once, before the first paint. */
function restoreSession(): Restored {
  const reports = storageService.getReports();
  const start: Restored = { reports, data: null, reportId: null, view: 'uploader' };
  // The CLI-served page loads live data instead (see below)
  if (servedByCli) return start;

  const savedView = safeSession.get('viewMode');
  const savedId = safeSession.get('currentReportId');
  if (savedView && savedId) {
    const found = reports.find((r) => r.id === savedId);
    if (found) return { reports, data: found.report, reportId: savedId, view: savedView === 'trends' ? 'trends' : 'dashboard' };
  } else if (savedView === 'trends' && calculateMonthlyTrends(reports).length >= 2) {
    return { ...start, view: 'trends' };
  }
  return start;
}

const App: React.FC = () => {
  const [initial] = useState(restoreSession);
  const [data, setData] = useState<UsageReport | null>(initial.data);
  const [savedReports, setSavedReports] = useState<StoredReport[]>(initial.reports);
  const [currentReportId, setCurrentReportId] = useState<string | null>(initial.reportId);
  const [showHistory, setShowHistory] = useState(false);
  const [viewMode, setViewMode] = useState<ViewMode>(initial.view);
  const [isLiveData, setIsLiveData] = useState(false);
  const [live, setLive] = useState<LiveStatus>({ connected: false, updatedAt: null });
  // When the CLI serves this page, the data is read straight away: no clicks needed
  const [readingLocal, setReadingLocal] = useState(servedByCli);
  const [startNotice, setStartNotice] = useState<StartNotice | null>(null);
  const [toast, setToast] = useState<Toast | null>(null);
  const [toastPaused, setToastPaused] = useState(false);
  // Becomes true once the person has moved around, so the start screen can take focus on a return and not on first load
  const [navigated, setNavigated] = useState(false);
  // Changing this key puts the screen back to a clean state after an error
  const [boundaryKey, setBoundaryKey] = useState(0);
  const historyRef = useRef<HTMLDivElement>(null);
  const historyButtonRef = useRef<HTMLButtonElement>(null);
  // A late answer from the analyzer must not revive a screen the person already left
  const liveRun = useRef(0);
  // Reports deleted while the "Undo" message is up, so Undo puts back exactly those
  const undoBuffer = useRef<StoredReport[]>([]);
  const deletePause = useRef(false);

  // Months of data among the saved reports. Trends need two.
  const trendMonths = useMemo(() => calculateMonthlyTrends(savedReports).length, [savedReports]);

  // Persist session state on changes
  useEffect(() => {
    safeSession.set('viewMode', viewMode);
    if (currentReportId) safeSession.set('currentReportId', currentReportId);
    else safeSession.remove('currentReportId');
  }, [viewMode, currentReportId]);

  // The tab title says where you are
  useEffect(() => { document.title = TITLES[viewMode]; }, [viewMode]);

  // A message that clears itself. It waits while the pointer or the keyboard is on it, so Undo cannot vanish under a hand.
  useEffect(() => {
    if (!toast) {
      undoBuffer.current = [];
      setToastPaused(false);
      return;
    }
    if (toastPaused) return;
    const t = setTimeout(() => setToast(null), toast.undo ? UNDO_MS : NOTE_MS);
    return () => clearTimeout(t);
  }, [toast, toastPaused]);

  // A file dropped anywhere that is not the start screen must not make the browser leave the page and open the file
  useEffect(() => {
    const hasFiles = (e: DragEvent) => Boolean(e.dataTransfer?.types?.includes('Files'));
    const stop = (e: DragEvent) => { if (hasFiles(e)) e.preventDefault(); };
    const drop = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      if (viewMode !== 'uploader') setToast({ message: 'To open a file, press New analysis first.' });
    };
    window.addEventListener('dragover', stop);
    window.addEventListener('drop', drop);
    return () => {
      window.removeEventListener('dragover', stop);
      window.removeEventListener('drop', drop);
    };
  }, [viewMode]);

  // Close the Saved list with Escape or a click elsewhere
  useEffect(() => {
    if (!showHistory) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { setShowHistory(false); historyButtonRef.current?.focus(); }
    };
    // pointerdown, not mousedown: a tap on a phone does not always send a mouse event
    const onPointer = (e: PointerEvent) => {
      if (historyRef.current && !historyRef.current.contains(e.target as Node)) setShowHistory(false);
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('pointerdown', onPointer);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('pointerdown', onPointer);
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

  const handleLiveRefresh = useCallback(async (): Promise<RefreshResult> => {
    if (!isLiveData) return 'error';
    const run = liveRun.current;
    const result = await fetchLocalUsage();
    // The person left this screen while the numbers were coming: say nothing about it
    if (run !== liveRun.current) return 'ok';
    if (result.ok === false) {
      if (result.reason === 'stopped') {
        setLive((l) => ({ ...l, connected: false }));
        return 'stopped';
      }
      return 'error';
    }
    setData(result.report);
    setLive({ connected: true, updatedAt: Date.now() });
    return 'ok';
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

    const keepFailed = "This report couldn't be kept in your browser (storage is full or blocked). It still shows for this visit.";
    const duplicate = storageService.findDuplicateReport(uploadedData);
    if (duplicate) {
      // Update the saved copy, so a reload shows the same numbers the person just saw
      if (storageService.updateReportData(duplicate.id, uploadedData)) setCurrentReportId(duplicate.id);
      else setToast({ message: keepFailed });
    } else {
      const saved = storageService.saveReport(uploadedData);
      if (saved) setCurrentReportId(saved.id);
      else setToast({ message: keepFailed });
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
    setNavigated(true);
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

  /** Show "Deleted ..." with an Undo that puts back everything deleted while the message is up. */
  const announceDeleted = (justDeleted: StoredReport[]) => {
    undoBuffer.current = [...undoBuffer.current, ...justDeleted];
    const count = undoBuffer.current.length;
    setToastPaused(false);
    setToast({
      message: count === 1 ? `Deleted ${plain(undoBuffer.current[0].name)}.` : `Deleted ${plural(count, 'saved report')}.`,
      undo: () => {
        const ok = storageService.restoreReports(undoBuffer.current);
        undoBuffer.current = [];
        setSavedReports(storageService.getReports());
        setToast({ message: ok ? 'Put back.' : "Couldn't put it back. Your browser's storage is full or blocked." });
      },
    });
  };

  const handleDeleteFromHistory = (stored: StoredReport) => {
    if (deletePause.current) return;
    deletePause.current = true;
    setTimeout(() => { deletePause.current = false; }, DELETE_PAUSE_MS);

    storageService.deleteReport(stored.id);
    setSavedReports(storageService.getReports());
    announceDeleted([stored]);
    if (currentReportId === stored.id) handleReset();
    // The delete button is gone, so focus goes to a place that still exists
    requestAnimationFrame(() => {
      (historyButtonRef.current ?? document.querySelector<HTMLElement>('main h1'))?.focus();
    });
  };

  const handleDeleteAll = () => {
    const before = storageService.getReports();
    storageService.clearHistory();
    setSavedReports([]);
    setShowHistory(false);
    announceDeleted(before);
    if (currentReportId) handleReset();
  };

  return (
    <div className="min-h-screen bg-[#0B0C15] text-slate-200 font-sans selection:bg-indigo-500/30 relative">
      {/* Soft background glow. Still, so nothing moves on its own. */}
      <div className="fixed inset-0 pointer-events-none" aria-hidden="true">
        <div className="absolute top-[-10%] left-[-10%] w-[40%] h-[40%] bg-indigo-900/20 rounded-full blur-[120px] mix-blend-screen"></div>
        <div className="absolute bottom-[-10%] right-[-10%] w-[40%] h-[40%] bg-purple-900/20 rounded-full blur-[120px] mix-blend-screen"></div>
      </div>

      <nav className="border-b border-white/10 bg-slate-950/80 backdrop-blur-xl sticky top-0 z-50">
        {/* "relative" makes this the box the Saved list is placed in, so on a phone it spans the screen and never runs off its edge */}
        <div className="relative max-w-7xl mx-auto px-4 md:px-6 min-h-16 py-2 flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 bg-linear-to-br from-indigo-500 via-purple-500 to-pink-500 rounded-xl flex items-center justify-center" aria-hidden="true">
              <Activity className="w-5 h-5 text-white" />
            </div>
            <span className="font-bold text-lg tracking-tight text-white/90">Usage<span className="text-indigo-300">Analyzer</span></span>
          </div>
          <div className="flex items-center gap-1 md:gap-3">
            {trendMonths >= 2 && viewMode !== 'trends' && (
              <button
                onClick={() => setViewMode('trends')}
                className="flex items-center gap-2 text-sm font-medium text-slate-200 hover:text-white px-3 min-h-11 rounded-full hover:bg-white/10"
              >
                <TrendingUp className="w-4 h-4" aria-hidden="true" />
                <span>Trends</span>
              </button>
            )}

            {savedReports.length > 0 && viewMode !== 'trends' && (
              <div ref={historyRef}>
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
                  <div id="saved-reports" className="absolute inset-x-4 md:inset-x-auto md:right-6 md:w-80 top-full mt-1 bg-slate-900 border border-white/15 rounded-xl shadow-xl z-50 overflow-hidden">
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

      {/* Right after the top bar in the reading order, so Undo is one Tab away from where a delete happened */}
      {toast && (
        <div
          role="status"
          onMouseEnter={() => setToastPaused(true)}
          onMouseLeave={() => setToastPaused(false)}
          onFocus={() => setToastPaused(true)}
          onBlur={() => setToastPaused(false)}
          className="fixed bottom-4 left-1/2 -translate-x-1/2 z-50 max-w-[calc(100vw-2rem)] bg-slate-800 border border-white/20 text-slate-100 text-sm rounded-xl shadow-xl pl-4 pr-1 py-1 flex items-center gap-1"
        >
          <span className="py-1 min-w-0 break-words">{toast.message}</span>
          {toast.undo && (
            <button onClick={toast.undo} className="font-semibold text-indigo-200 hover:text-white underline min-h-11 px-2">Undo</button>
          )}
          <button onClick={() => setToast(null)} aria-label="Dismiss message" className="min-w-11 min-h-11 flex items-center justify-center text-slate-300 hover:text-white">
            <X className="w-4 h-4" aria-hidden="true" />
          </button>
        </div>
      )}

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
            <Uploader onDataLoaded={handleDataLoaded} onLoadDemo={handleLoadDemo} initialNotice={startNotice} focusHeading={navigated} />
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
    </div>
  );
};

export default App;
