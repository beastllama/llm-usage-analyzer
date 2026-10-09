import React, { useState, useEffect, useRef } from 'react';
import {
  Upload, Play, Terminal, FileUp, Globe, ArrowLeft, AlertCircle,
  Copy, Check, Wifi, ExternalLink, Loader2, ShieldCheck, Download,
} from 'lucide-react';
import { UsageReport } from '../types';
import { parseUsageFile } from '../services/fileImport';
import { copyText } from '../services/shareService';
import { LOCAL_SERVER_URL, servedByCli, pageIsLocal } from '../services/localServer';

const RUN_COMMAND = 'npx llm-usage-analyzer';

interface UploaderProps {
  onDataLoaded: (data: UsageReport, fromLiveServer?: boolean) => void;
  onLoadDemo: () => void;
  /** A message to show on arrival, for example when the local data could not be read. */
  initialError?: string | null;
}

type ViewState = 'main' | 'web' | 'file';

const Uploader: React.FC<UploaderProps> = ({ onDataLoaded, onLoadDemo, initialError = null }) => {
  const [view, setView] = useState<ViewState>('main');
  const [error, setError] = useState<string | null>(initialError);
  const [dragActive, setDragActive] = useState(false);
  const [copied, setCopied] = useState(false);
  const [serverStatus, setServerStatus] = useState<'checking' | 'available' | 'unavailable'>(servedByCli ? 'available' : 'checking');
  const [serverLoading, setServerLoading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Dev server on this computer: if the local server is running, offer to load from it.
  // A page on a public host never probes localhost (the browser would ask the visitor for permission).
  useEffect(() => {
    if (view !== 'main' || servedByCli || !pageIsLocal) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`${LOCAL_SERVER_URL}/api/health`, { signal: AbortSignal.timeout(2000) });
        if (!cancelled) setServerStatus(res.ok ? 'available' : 'unavailable');
      } catch {
        if (!cancelled) setServerStatus('unavailable');
      }
    })();
    return () => { cancelled = true; };
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

  const loadFromServer = async () => {
    setServerLoading(true);
    setError(null);
    try {
      const res = await fetch(`${LOCAL_SERVER_URL}/api/usage`);
      if (!res.ok) throw new Error('The local server could not read your Claude Code history.');
      onDataLoaded((await res.json()) as UsageReport, true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load from the local server.');
    } finally {
      setServerLoading(false);
    }
  };

  const copyCommand = async () => {
    const ok = await copyText(RUN_COMMAND);
    setCopied(ok);
    if (ok) setTimeout(() => setCopied(false), 2000);
  };

  const processFile = async (file: File) => {
    setError(null);
    const result = parseUsageFile(await file.text(), file.size, 'Claude Pro');
    if ('error' in result) {
      setError(result.error);
      return;
    }
    onDataLoaded(result.report);
  };

  const handleDrag = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.type === 'dragenter' || e.type === 'dragover') setDragActive(true);
    else if (e.type === 'dragleave') setDragActive(false);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragActive(false);
    if (e.dataTransfer.files?.[0]) processFile(e.dataTransfer.files[0]);
  };

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) processFile(file);
    // Allow choosing the same file again after an error
    e.target.value = '';
  };

  const goBack = () => {
    setError(null);
    setView('main');
  };

  const dropZone = (hint: string) => (
    <div
      className={`relative w-full border-2 border-dashed rounded-2xl p-8 transition-colors flex flex-col items-center text-center ${
        dragActive ? 'border-indigo-400 bg-indigo-500/10' : 'border-slate-700 hover:border-slate-500'
      }`}
      onDragEnter={handleDrag}
      onDragLeave={handleDrag}
      onDragOver={handleDrag}
      onDrop={handleDrop}
    >
      <input
        ref={fileInputRef}
        type="file"
        className="sr-only"
        tabIndex={-1}
        aria-hidden="true"
        onChange={handleChange}
        accept=".json,application/json"
      />
      <Upload className="w-8 h-8 text-slate-400 mb-3" aria-hidden="true" />
      <p className="text-white font-semibold mb-1">{dragActive ? 'Drop to upload' : 'Drop your file here'}</p>
      <p className="text-slate-500 text-sm mb-5 max-w-sm">{hint}</p>
      <button
        type="button"
        onClick={() => fileInputRef.current?.click()}
        className="px-6 py-2.5 bg-slate-200 hover:bg-white text-slate-900 font-semibold rounded-lg focus-visible:ring-2 focus-visible:ring-indigo-400 focus-visible:ring-offset-2 focus-visible:ring-offset-slate-900"
      >
        Choose file
      </button>
    </div>
  );

  return (
    <div className="max-w-3xl mx-auto px-4 py-10 space-y-8">
      <header className="text-center space-y-3">
        <h1 className="text-4xl md:text-5xl font-bold tracking-tight text-white">Is your Claude plan worth it?</h1>
        <p className="text-lg text-slate-400">
          See what your usage would cost at pay-as-you-go prices. It runs on your computer. No login, no keys.
        </p>
      </header>

      {error && (
        <div role="alert" className="p-4 bg-red-500/10 border border-red-500/20 rounded-xl text-red-200 text-sm flex items-start gap-3">
          <AlertCircle className="w-5 h-5 text-red-400 shrink-0" aria-hidden="true" />
          <span className="flex-1">{error}</span>
          <button onClick={() => setError(null)} aria-label="Dismiss message" className="text-red-200 hover:text-white px-1">✕</button>
        </div>
      )}

      {view !== 'main' && (
        <button onClick={goBack} className="flex items-center gap-2 text-sm text-slate-400 hover:text-white" aria-label="Back">
          <ArrowLeft className="w-4 h-4" aria-hidden="true" /> Back
        </button>
      )}

      {view === 'main' && (
        <div className="space-y-6">
          {/* Path 1: Claude Code. One command. */}
          <section aria-labelledby="cc-title" className="bg-slate-900/70 border border-indigo-500/40 rounded-2xl p-6 md:p-8 space-y-5">
            <div className="flex items-center gap-3">
              <div className="p-2.5 rounded-xl bg-indigo-500/15 text-indigo-300"><Terminal className="w-6 h-6" aria-hidden="true" /></div>
              <div>
                <h2 id="cc-title" className="text-xl font-bold text-white">I use Claude Code</h2>
                <p className="text-sm text-slate-400">{servedByCli ? 'Reads the history Claude Code keeps on this computer.' : 'Run one command. Your browser opens with your answer.'}</p>
              </div>
              <span className="ml-auto text-xs font-semibold text-indigo-300 bg-indigo-500/10 px-2.5 py-1 rounded-full">Recommended</span>
            </div>

            {!servedByCli && (
              <div className="flex items-center gap-2 bg-slate-950 border border-slate-700 rounded-xl p-2 pl-4">
                <code className="flex-1 font-mono text-emerald-300 text-sm md:text-base overflow-x-auto whitespace-nowrap">{RUN_COMMAND}</code>
                <button
                  onClick={copyCommand}
                  className="flex items-center gap-2 px-4 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-sm text-white"
                >
                  {copied ? <><Check className="w-4 h-4 text-green-400" aria-hidden="true" /> Copied</> : <><Copy className="w-4 h-4" aria-hidden="true" /> Copy</>}
                </button>
              </div>
            )}

            {serverStatus === 'available' && (
              <button
                onClick={loadFromServer}
                disabled={serverLoading}
                className="w-full flex items-center justify-center gap-2 px-5 py-3 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-white font-semibold disabled:opacity-60"
              >
                {serverLoading
                  ? <><Loader2 className="w-5 h-5 animate-spin" aria-hidden="true" /> Loading…</>
                  : <><Wifi className="w-5 h-5" aria-hidden="true" /> {servedByCli ? 'Read my Claude Code history' : 'A local server is running. Load my data'}</>}
              </button>
            )}

            <p className="text-xs text-slate-500 flex items-center gap-2">
              <ShieldCheck className="w-4 h-4 shrink-0" aria-hidden="true" />
              Your history stays on this computer. The page can't send it anywhere.
            </p>
          </section>

          {/* Path 2: claude.ai in the browser */}
          <section aria-labelledby="web-title" className="bg-slate-900/50 border border-white/10 rounded-2xl p-6 flex flex-wrap items-center gap-4">
            <div className="p-2.5 rounded-xl bg-purple-500/15 text-purple-300"><Globe className="w-6 h-6" aria-hidden="true" /></div>
            <div className="flex-1 min-w-[12rem]">
              <h2 id="web-title" className="text-lg font-bold text-white">I use claude.ai in my browser</h2>
              <p className="text-sm text-slate-400">Export your chats and drop the file in.</p>
            </div>
            <button onClick={() => setView('web')} className="px-5 py-2.5 rounded-lg border border-slate-600 text-slate-200 hover:bg-slate-800 text-sm font-medium">
              Show me how
            </button>
          </section>

          <div className="flex flex-wrap items-center justify-center gap-x-6 gap-y-2 text-sm">
            <button onClick={() => setView('file')} className="flex items-center gap-2 text-slate-400 hover:text-white">
              <FileUp className="w-4 h-4" aria-hidden="true" /> I already have a usage report file
            </button>
            <button onClick={onLoadDemo} className="flex items-center gap-2 text-slate-400 hover:text-white">
              <Play className="w-4 h-4" aria-hidden="true" /> Try the demo
            </button>
          </div>
        </div>
      )}

      {view === 'web' && (
        <div className="space-y-6">
          <section aria-labelledby="export-title" className="bg-slate-900/60 border border-white/10 rounded-2xl p-6 space-y-4">
            <h2 id="export-title" className="text-xl font-bold text-white flex items-center gap-2">
              <Download className="w-5 h-5 text-purple-300" aria-hidden="true" /> Export your claude.ai chats
            </h2>
            <ol className="space-y-3 text-sm text-slate-300 list-decimal list-inside">
              <li>
                Open{' '}
                <a href="https://claude.ai" target="_blank" rel="noopener noreferrer" className="text-purple-300 hover:text-purple-200 inline-flex items-center gap-1">
                  claude.ai <ExternalLink className="w-3 h-3" aria-hidden="true" />
                </a>{' '}
                and sign in.
              </li>
              <li>Click your profile (bottom left), then <strong className="text-white">Settings</strong>.</li>
              <li>Open <strong className="text-white">Account</strong>, find <strong className="text-white">Export Data</strong>, and click <strong className="text-white">Export</strong>.</li>
              <li>Claude emails you a link. Download the ZIP and unzip it.</li>
              <li>Drop <strong className="text-white">conversations.json</strong> below.</li>
            </ol>
            <p className="text-xs text-slate-400 bg-amber-500/10 border border-amber-500/20 rounded-lg p-3">
              claude.ai doesn't record which model answered, so a cost can't be worked out. You'll see your activity instead.
              For your real limit, open claude.ai, then <strong className="text-slate-200">Settings → Usage</strong>.
            </p>
          </section>
          {dropZone('Upload conversations.json. It is read in your browser and not sent anywhere.')}
        </div>
      )}

      {view === 'file' && dropZone('Upload usage_report.json from the command line. It is read in your browser and not sent anywhere.')}
    </div>
  );
};

export default Uploader;
