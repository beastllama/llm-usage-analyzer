import React, { Component, useState, useEffect, useCallback } from 'react';
import Uploader from './components/Uploader';
import AnalysisDashboard from './components/AnalysisDashboard';
import HistoryView from './components/HistoryView';
import { UsageReport, StoredReport } from './types';
import { MOCK_DATA } from './constants';
import { Activity, History, ChevronDown, Trash2, X, TrendingUp } from 'lucide-react';
import { storageService } from './services/storageService';

type ViewMode = 'uploader' | 'dashboard' | 'trends';

const LOCAL_SERVER_URL = 'http://localhost:3456';

/** Catches render errors so one bad file cannot leave a blank page. */
interface ErrorBoundaryProps {
  children: React.ReactNode;
  onReset: () => void;
}

interface ErrorBoundaryState {
  error: Error | null;
}

class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  render() {
    if (this.state.error) {
      return (
        <div role="alert" className="max-w-md mx-auto text-center py-20 px-4 space-y-4">
          <h2 className="text-xl font-bold text-white">Something went wrong showing this report.</h2>
          <p className="text-slate-400 text-sm">Your saved reports are still there. Start over and try the file again.</p>
          <button
            onClick={() => { this.setState({ error: null }); this.props.onReset(); }}
            className="px-5 py-2 rounded-lg bg-indigo-500 hover:bg-indigo-400 text-white font-medium"
          >
            Start over
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

const App: React.FC = () => {
  const [data, setData] = useState<UsageReport | null>(null);
  const [savedReports, setSavedReports] = useState<StoredReport[]>([]);
  const [currentReportId, setCurrentReportId] = useState<string | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const [viewMode, setViewMode] = useState<ViewMode>('uploader');
  const [isLiveData, setIsLiveData] = useState(false);
  const [liveServerConnected, setLiveServerConnected] = useState(false);

  // Initialize storage and restore session state on mount
  useEffect(() => {
    storageService.init();
    const reports = storageService.getReports();
    setSavedReports(reports);

    // Restore session state (survives browser refresh)
    const savedViewMode = sessionStorage.getItem('viewMode') as ViewMode;
    const savedReportId = sessionStorage.getItem('currentReportId');

    if (savedViewMode && savedReportId) {
      const report = reports.find(r => r.id === savedReportId);
      if (report) {
        setData(report.report);
        setCurrentReportId(savedReportId);
        setViewMode(savedViewMode === 'trends' ? 'trends' : 'dashboard');
      }
    } else if (savedViewMode === 'trends') {
      setViewMode('trends');
    }
  }, []);

  // Persist session state on changes
  useEffect(() => {
    sessionStorage.setItem('viewMode', viewMode);
    if (currentReportId) {
      sessionStorage.setItem('currentReportId', currentReportId);
    } else {
      sessionStorage.removeItem('currentReportId');
    }
  }, [viewMode, currentReportId]);

  // Check server connection when in live mode
  useEffect(() => {
    if (!isLiveData) {
      setLiveServerConnected(false);
      return;
    }

    const checkConnection = async () => {
      try {
        const res = await fetch(`${LOCAL_SERVER_URL}/api/health`, {
          signal: AbortSignal.timeout(2000)
        });
        setLiveServerConnected(res.ok);
      } catch {
        setLiveServerConnected(false);
      }
    };

    checkConnection();
    const interval = setInterval(checkConnection, 5000);
    return () => clearInterval(interval);
  }, [isLiveData]);

  // Refresh data from live server
  const handleLiveRefresh = useCallback(async () => {
    if (!isLiveData) return;
    try {
      const res = await fetch(`${LOCAL_SERVER_URL}/api/usage`);
      if (res.ok) {
        const newData = await res.json() as UsageReport;
        setData(newData);
        setLiveServerConnected(true);
      }
    } catch {
      setLiveServerConnected(false);
    }
  }, [isLiveData]);

  const handleDataLoaded = useCallback((uploadedData: UsageReport, fromLiveServer: boolean = false) => {
    setData(uploadedData);
    setViewMode('dashboard');
    setIsLiveData(fromLiveServer);
    if (fromLiveServer) {
      setLiveServerConnected(true);
    }

    // Live data is not saved, because it changes. Reports opened from history are not saved again.
    if (fromLiveServer || currentReportId) return;

    // Empty reports are not saved
    const total = uploadedData.usage.tokens.input + uploadedData.usage.tokens.output;
    if (total === 0 && uploadedData.usage.messages.count === 0) return;

    try {
      const duplicate = storageService.findDuplicateReport(uploadedData);
      if (duplicate) {
        // Update the saved copy, so a reload shows the same numbers the user just saw
        storageService.updateReportData(duplicate.id, uploadedData);
        setCurrentReportId(duplicate.id);
      } else {
        const saved = storageService.saveReport(uploadedData);
        setCurrentReportId(saved.id);
      }
      setSavedReports(storageService.getReports());
    } catch {
      // Storage is blocked or full. The report still shows for this visit.
    }
  }, [currentReportId]);

  const handleLoadDemo = () => {
    setData(MOCK_DATA);
    setCurrentReportId(null); // Demo data is not saved
    setIsLiveData(false);
    setViewMode('dashboard');
  };

  const handleReset = () => {
    setData(null);
    setCurrentReportId(null);
    setIsLiveData(false);
    setViewMode('uploader');
    sessionStorage.removeItem('viewMode');
    sessionStorage.removeItem('currentReportId');
  };

  const handleViewTrends = () => {
    setViewMode('trends');
  };

  const handleBackFromTrends = () => {
    setViewMode(data ? 'dashboard' : 'uploader');
  };

  const handleLoadFromHistory = (stored: StoredReport) => {
    setData(stored.report);
    setCurrentReportId(stored.id);
    setIsLiveData(false);
    setShowHistory(false);
    setViewMode('dashboard');
  };

  const handleDeleteFromHistory = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    storageService.deleteReport(id);
    setSavedReports(storageService.getReports());

    if (currentReportId === id) {
      setData(null);
      setCurrentReportId(null);
      setViewMode('uploader');
    }
  };

  const formatDate = (dateStr: string) => {
    return new Date(dateStr).toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });
  };

  return (
    <div className="min-h-screen bg-[#0B0C15] text-slate-200 font-sans selection:bg-indigo-500/30 relative">
      {/* Soft background glow. Motion is off for people who ask for reduced motion. */}
      <div className="fixed inset-0 pointer-events-none" aria-hidden="true">
        <div className="motion-safe:animate-pulse absolute top-[-10%] left-[-10%] w-[40%] h-[40%] bg-indigo-900/20 rounded-full blur-[120px] mix-blend-screen" style={{ animationDuration: '4s' }}></div>
        <div className="motion-safe:animate-pulse absolute bottom-[-10%] right-[-10%] w-[40%] h-[40%] bg-purple-900/20 rounded-full blur-[120px] mix-blend-screen" style={{ animationDuration: '6s' }}></div>
      </div>

      <nav className="border-b border-white/5 bg-slate-950/60 backdrop-blur-xl sticky top-0 z-50">
        <div className="max-w-7xl mx-auto px-4 md:px-6 min-h-16 py-3 flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 bg-linear-to-br from-indigo-500 via-purple-500 to-pink-500 rounded-xl flex items-center justify-center" aria-hidden="true">
              <Activity className="w-5 h-5 text-white" />
            </div>
            <span className="font-bold text-lg tracking-tight text-white/90">Usage<span className="text-indigo-400">Analyzer</span></span>
          </div>
          <div className="flex items-center gap-1 md:gap-3">
            {savedReports.length >= 1 && viewMode !== 'trends' && (
              <button
                onClick={handleViewTrends}
                className="flex items-center gap-2 text-sm font-medium text-slate-300 hover:text-white px-3 py-1.5 rounded-full hover:bg-white/5"
              >
                <TrendingUp className="w-4 h-4" aria-hidden="true" />
                <span>Trends</span>
              </button>
            )}

            {savedReports.length > 0 && viewMode !== 'trends' && (
              <div className="relative">
                <button
                  onClick={() => setShowHistory(!showHistory)}
                  aria-expanded={showHistory}
                  className="flex items-center gap-2 text-sm font-medium text-slate-300 hover:text-white px-3 py-1.5 rounded-full hover:bg-white/5"
                >
                  <History className="w-4 h-4" aria-hidden="true" />
                  <span>Saved ({savedReports.length})</span>
                  <ChevronDown className={`w-4 h-4 transition-transform ${showHistory ? 'rotate-180' : ''}`} aria-hidden="true" />
                </button>

                {showHistory && (
                  <>
                    <div className="fixed inset-0 z-40" onClick={() => setShowHistory(false)} aria-hidden="true" />
                    <div className="absolute right-0 mt-2 w-[min(18rem,calc(100vw-2rem))] bg-slate-900 border border-white/10 rounded-xl shadow-xl z-50 overflow-hidden">
                      <div className="p-3 border-b border-white/5 flex items-center justify-between">
                        <span className="text-xs font-medium text-slate-400">Saved reports</span>
                        <button onClick={() => setShowHistory(false)} aria-label="Close saved reports" className="text-slate-400 hover:text-white">
                          <X className="w-4 h-4" aria-hidden="true" />
                        </button>
                      </div>
                      <ul className="max-h-64 overflow-y-auto">
                        {savedReports.map((stored) => (
                          <li key={stored.id} className="group flex items-center hover:bg-white/5">
                            <button
                              onClick={() => handleLoadFromHistory(stored)}
                              className={`flex-1 min-w-0 px-4 py-3 text-left ${
                                currentReportId === stored.id ? 'border-l-2 border-indigo-500 bg-indigo-500/10' : ''
                              }`}
                            >
                              <div className="text-sm font-medium text-white truncate">{stored.name}</div>
                              <div className="text-xs text-slate-500">Saved {formatDate(stored.savedAt)}</div>
                            </button>
                            <button
                              onClick={(e) => handleDeleteFromHistory(stored.id, e)}
                              aria-label={`Delete ${stored.name}`}
                              className="p-3 text-slate-400 hover:text-red-300 opacity-100 md:opacity-0 md:group-hover:opacity-100 focus:opacity-100"
                            >
                              <Trash2 className="w-4 h-4" aria-hidden="true" />
                            </button>
                          </li>
                        ))}
                      </ul>
                    </div>
                  </>
                )}
              </div>
            )}

            <a
              href="https://github.com/beastllama/llm-usage-analyzer"
              target="_blank"
              rel="noopener noreferrer"
              className="text-sm font-medium text-slate-300 hover:text-white px-3 py-1.5 rounded-full hover:bg-white/5"
            >
              GitHub
            </a>
          </div>
        </div>
      </nav>

      <main className="relative z-10">
        <ErrorBoundary onReset={handleReset}>
          {viewMode === 'uploader' && (
            <Uploader onDataLoaded={handleDataLoaded} onLoadDemo={handleLoadDemo} />
          )}
          {viewMode === 'dashboard' && data && (
            <AnalysisDashboard
              data={data}
              onReset={handleReset}
              isLiveData={isLiveData}
              liveServerConnected={liveServerConnected}
              onLiveRefresh={handleLiveRefresh}
            />
          )}
          {viewMode === 'trends' && (
            <HistoryView reports={savedReports} onBack={handleBackFromTrends} />
          )}
        </ErrorBoundary>
      </main>
    </div>
  );
};

export default App;
