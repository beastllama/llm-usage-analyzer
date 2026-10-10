import React, { useState, useEffect, useRef } from 'react';
import {
  Upload, Play, Terminal, FileUp, Globe, ArrowLeft, AlertCircle,
  Copy, Check, ExternalLink, Loader2, ShieldCheck, Download, BarChart3, FileSpreadsheet,
} from 'lucide-react';
import { UsageReport } from '../types';
import { parseUsageFile, MAX_FILE_BYTES, ZIP_MESSAGE, ZIP_SIGNATURE, TOO_BIG_MESSAGE } from '../services/fileImport';
import { copyText } from '../services/shareService';
import { fetchLocalUsage, localServerIsUp, servedByCli, pageIsLocal } from '../services/localServer';

const RUN_COMMAND = 'npx llm-usage-analyzer';

export interface StartNotice {
  kind: 'no-history' | 'error';
  text: string;
}

interface UploaderProps {
  onDataLoaded: (reports: UsageReport[], fromLiveServer?: boolean) => void;
  onLoadDemo: () => void;
  /** A message to show on arrival, for example when the local history could not be read. */
  initialNotice?: StartNotice | null;
  /** Move focus to the heading on arrival. Used when the person came back to this screen, so a screen reader starts at the top. */
  focusHeading?: boolean;
}

type ViewState = 'main' | 'web' | 'cursor' | 'file';

const Uploader: React.FC<UploaderProps> = ({ onDataLoaded, onLoadDemo, initialNotice = null, focusHeading = false }) => {
  const [view, setView] = useState<ViewState>('main');
  const [notice, setNotice] = useState<StartNotice | null>(initialNotice);
  const [dragActive, setDragActive] = useState(false);
  const [copied, setCopied] = useState<'yes' | 'no' | null>(null);
  const [serverFound, setServerFound] = useState(false);
  const [serverLoading, setServerLoading] = useState(false);
  // A big file takes a moment to read, so the screen says so
  const [readingFile, setReadingFile] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    if (!focusHeading) return;
    window.scrollTo(0, 0);
    headingRef.current?.focus({ preventScroll: true });
    // Only on arrival
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Dev server on this computer: if the local server is running, offer to load from it.
  // A page on a public host never probes localhost (the browser would ask the visitor for permission).
  useEffect(() => {
    if (view !== 'main' || servedByCli || !pageIsLocal) return;
    let cancelled = false;
    localServerIsUp(2000).then((up) => { if (!cancelled) setServerFound(up); });
    return () => { cancelled = true; };
  }, [view]);

  const processFile = async (file: File) => {
    setNotice(null);
    setReadingFile(true);
    try {
      await openFile(file);
    } finally {
      setReadingFile(false);
    }
  };

  const openFile = async (file: File) => {
    // A ZIP is named as a ZIP whatever its size, so a big export ZIP gets "unzip it" and not "too big"
    try {
      if ((await file.slice(0, ZIP_SIGNATURE.length).text()) === ZIP_SIGNATURE) {
        setNotice({ kind: 'error', text: ZIP_MESSAGE });
        return;
      }
    } catch {
      // Reading is tried again below, with its own message
    }
    if (file.size > MAX_FILE_BYTES) {
      setNotice({ kind: 'error', text: TOO_BIG_MESSAGE });
      return;
    }
    let text: string;
    try {
      text = await file.text();
    } catch {
      setNotice({ kind: 'error', text: "We couldn't open that file. Is it a file, and not a folder?" });
      return;
    }
    const result = parseUsageFile(text, file.size);
    if (result.ok === false) {
      setNotice({ kind: 'error', text: result.error });
      return;
    }
    onDataLoaded(result.reports);
  };

  // A file dropped anywhere on the page opens here. It never opens in a new browser tab.
  const processFileRef = useRef(processFile);
  processFileRef.current = processFile;
  useEffect(() => {
    const block = (e: DragEvent) => e.preventDefault();
    const drop = (e: DragEvent) => {
      e.preventDefault();
      setDragActive(false);
      const file = e.dataTransfer?.files?.[0];
      if (file) processFileRef.current(file);
    };
    window.addEventListener('dragover', block);
    window.addEventListener('drop', drop);
    return () => {
      window.removeEventListener('dragover', block);
      window.removeEventListener('drop', drop);
    };
  }, []);

  const loadFromServer = async () => {
    setServerLoading(true);
    setNotice(null);
    const result = await fetchLocalUsage();
    setServerLoading(false);
    if (result.ok === false) {
      setNotice({ kind: result.reason === 'no-history' ? 'no-history' : 'error', text: result.message });
      return;
    }
    onDataLoaded(result.reports, true);
  };

  const copyCommand = async () => {
    const ok = await copyText(RUN_COMMAND);
    setCopied(ok ? 'yes' : 'no');
    setTimeout(() => setCopied(null), 2500);
  };

  const handleDrag = (e: React.DragEvent) => {
    e.preventDefault();
    if (e.type === 'dragenter' || e.type === 'dragover') setDragActive(true);
    // Moving over a child element also fires dragleave. Only a real exit from the zone turns the highlight off.
    else if (e.type === 'dragleave' && !e.currentTarget.contains(e.relatedTarget as Node | null)) setDragActive(false);
  };

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) processFile(file);
    // Allow choosing the same file again after an error
    e.target.value = '';
  };

  const goBack = () => {
    setNotice(null);
    setView('main');
    requestAnimationFrame(() => headingRef.current?.focus());
  };

  const openView = (next: ViewState) => {
    setNotice(null);
    setView(next);
    requestAnimationFrame(() => headingRef.current?.focus());
  };

  const noHistory = notice?.kind === 'no-history';

  const dropZone = (hint: string) => (
    <div
      className={`relative w-full border-2 border-dashed rounded-2xl p-8 transition-colors flex flex-col items-center text-center ${
        dragActive ? 'border-indigo-400 bg-indigo-500/10' : 'border-slate-600 hover:border-slate-400'
      }`}
      onDragEnter={handleDrag}
      onDragLeave={handleDrag}
      onDragOver={handleDrag}
    >
      <input
        ref={fileInputRef}
        type="file"
        className="sr-only"
        tabIndex={-1}
        aria-hidden="true"
        onChange={handleChange}
        accept=".json,application/json,.csv,text/csv"
      />
      <Upload className="w-8 h-8 text-slate-300 mb-3" aria-hidden="true" />
      <p className="text-white font-semibold mb-1">{dragActive ? 'Drop to open' : 'Drop your file here'}</p>
      <p className="text-slate-400 text-sm mb-5 max-w-sm">{hint}</p>
      <button
        type="button"
        onClick={() => fileInputRef.current?.click()}
        className="px-6 min-h-11 bg-slate-200 hover:bg-white text-slate-900 font-semibold rounded-lg focus-visible:ring-2 focus-visible:ring-indigo-400 focus-visible:ring-offset-2 focus-visible:ring-offset-slate-900"
      >
        Choose file
      </button>
      <p role="status" className="text-sm text-slate-200 mt-3 min-h-5 flex items-center gap-2">
        {readingFile && <><Loader2 className="w-4 h-4 motion-safe:animate-spin" aria-hidden="true" /> Reading your file…</>}
      </p>
    </div>
  );

  return (
    <div className="max-w-3xl mx-auto px-4 py-10 space-y-8">
      <header className="text-center space-y-3">
        <h1
          ref={headingRef}
          tabIndex={-1}
          className="text-4xl md:text-5xl font-bold tracking-tight text-white outline-none"
        >
          See if your AI plans beat paying per use.
        </h1>
        <p className="text-lg text-slate-300">Runs on your computer. No login. No API key.</p>
      </header>

      {notice && (
        <div role="alert" className="p-4 bg-red-500/10 border border-red-500/30 rounded-xl text-red-100 text-sm flex items-start gap-3">
          <AlertCircle className="w-5 h-5 text-red-300 shrink-0" aria-hidden="true" />
          <span className="flex-1">{notice.text}</span>
          <button onClick={() => setNotice(null)} aria-label="Dismiss message" className="text-red-100 hover:text-white min-w-11 min-h-11 -my-3 -mr-3">✕</button>
        </div>
      )}

      {view !== 'main' && (
        <button onClick={goBack} className="flex items-center gap-2 text-sm text-slate-300 hover:text-white min-h-11">
          <ArrowLeft className="w-4 h-4" aria-hidden="true" /> Back
        </button>
      )}

      {view === 'main' && (
        <div className="space-y-6">
          {/* Path 1: Claude Code. One command. */}
          <section aria-labelledby="cc-title" className={`bg-slate-900/70 border rounded-2xl p-6 md:p-8 space-y-5 ${noHistory ? 'border-white/10' : 'border-indigo-500/40'}`}>
            <div className="flex items-center gap-3 flex-wrap">
              <div className="p-2.5 rounded-xl bg-indigo-500/15 text-indigo-300"><Terminal className="w-6 h-6" aria-hidden="true" /></div>
              <div className="flex-1 min-w-[10rem]">
                <h2 id="cc-title" className="text-xl font-bold text-white">I use Claude Code, Codex CLI or Gemini CLI</h2>
                <p className="text-sm text-slate-300">
                  {servedByCli ? 'Reads the history these tools keep on this computer.' : 'Run one command. Your browser opens with your answer for each tool.'}
                </p>
              </div>
              {!noHistory && <span className="text-xs font-semibold text-indigo-200 bg-indigo-500/15 px-2.5 py-1 rounded-full">Recommended</span>}
            </div>

            {!servedByCli && (
              <div className="flex items-center gap-2 bg-slate-950 border border-slate-700 rounded-xl p-2 pl-4">
                <code className="flex-1 font-mono text-emerald-300 text-sm md:text-base overflow-x-auto whitespace-nowrap">{RUN_COMMAND}</code>
                <button
                  onClick={copyCommand}
                  className="flex items-center gap-2 px-4 min-h-11 rounded-lg bg-slate-800 hover:bg-slate-700 text-sm text-white"
                >
                  {copied === 'yes'
                    ? <><Check className="w-4 h-4 text-green-400" aria-hidden="true" /> Copied</>
                    : <><Copy className="w-4 h-4" aria-hidden="true" /> Copy</>}
                </button>
              </div>
            )}
            <p role="status" className="text-sm text-slate-300 min-h-5">
              {copied === 'yes' && 'Copied. Paste it into a terminal and press Enter.'}
              {copied === 'no' && 'Your browser blocked copying. Select the command and copy it by hand.'}
            </p>

            {(servedByCli || serverFound) && (
              <button
                onClick={loadFromServer}
                disabled={serverLoading}
                className="w-full flex items-center justify-center gap-2 px-5 min-h-12 rounded-xl bg-emerald-700 hover:bg-emerald-600 text-white font-semibold disabled:opacity-60"
              >
                {serverLoading
                  ? <><Loader2 className="w-5 h-5 motion-safe:animate-spin" aria-hidden="true" /> Reading…</>
                  : <><BarChart3 className="w-5 h-5" aria-hidden="true" />
                      {servedByCli
                        ? (noHistory ? 'Look again' : 'Read my history')
                        : 'Found the analyzer on this computer. Load my data'}</>}
              </button>
            )}

            <p className="text-xs text-slate-300 flex items-start gap-2">
              <ShieldCheck className="w-4 h-4 shrink-0 mt-px" aria-hidden="true" />
              Your history stays on this computer. Nothing is uploaded.
            </p>
          </section>

          {/* Path 2: Cursor, from its usage export */}
          <section aria-labelledby="cursor-title" className="bg-slate-900/50 border border-white/10 rounded-2xl p-6 flex flex-wrap items-center gap-4">
            <div className="p-2.5 rounded-xl bg-sky-500/15 text-sky-300"><FileSpreadsheet className="w-6 h-6" aria-hidden="true" /></div>
            <div className="flex-1 min-w-[12rem]">
              <h2 id="cursor-title" className="text-lg font-bold text-white">I use Cursor</h2>
              <p className="text-sm text-slate-300">Export your usage from Cursor and drop the file in.</p>
            </div>
            <button onClick={() => openView('cursor')} className="px-5 min-h-11 rounded-lg border border-slate-500 text-slate-100 hover:bg-slate-800 text-sm font-medium">
              Show me how
            </button>
          </section>

          {/* Path 3: claude.ai in the browser */}
          <section aria-labelledby="web-title" className={`bg-slate-900/50 border rounded-2xl p-6 flex flex-wrap items-center gap-4 ${noHistory ? 'border-indigo-500/40' : 'border-white/10'}`}>
            <div className="p-2.5 rounded-xl bg-purple-500/15 text-purple-300"><Globe className="w-6 h-6" aria-hidden="true" /></div>
            <div className="flex-1 min-w-[12rem]">
              <h2 id="web-title" className="text-lg font-bold text-white">I use claude.ai in my browser</h2>
              <p className="text-sm text-slate-300">Export your chats and drop the file in.</p>
            </div>
            <button onClick={() => openView('web')} className="px-5 min-h-11 rounded-lg border border-slate-500 text-slate-100 hover:bg-slate-800 text-sm font-medium">
              Show me how
            </button>
          </section>

          <div className="flex flex-wrap items-center justify-center gap-x-6 gap-y-1 text-sm">
            <button onClick={() => openView('file')} className="flex items-center gap-2 text-slate-300 hover:text-white min-h-11">
              <FileUp className="w-4 h-4" aria-hidden="true" /> I already have a usage report file
            </button>
            <button onClick={onLoadDemo} className="flex items-center gap-2 text-slate-300 hover:text-white min-h-11">
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
            <p className="text-sm text-slate-200 bg-amber-500/10 border border-amber-500/30 rounded-lg p-3">
              A chat export shows your activity only. claude.ai doesn't say which model replied, so we can't price it.
              For your real limit, open claude.ai, then <strong className="text-white">Settings → Usage</strong>.
            </p>
            <ol className="space-y-3 text-sm text-slate-200 list-decimal list-inside">
              <li>
                Open{' '}
                <a href="https://claude.ai" target="_blank" rel="noopener noreferrer" className="text-purple-300 hover:text-purple-200 inline-flex items-center gap-1">
                  claude.ai <ExternalLink className="w-3 h-3" aria-hidden="true" /><span className="sr-only">(opens in a new tab)</span>
                </a>{' '}
                in a browser or the Claude desktop app, and sign in. The phone apps can't start an export.
              </li>
              <li>Click your initials (bottom left), then <strong className="text-white">Settings</strong>.</li>
              <li>Open <strong className="text-white">Privacy</strong> and click <strong className="text-white">Export data</strong>.</li>
              <li>Claude emails you a download link. It expires after 24 hours.</li>
              <li>Download it. If it is a ZIP, unzip it. Then choose the file named <strong className="text-white">conversations.json</strong> below.</li>
            </ol>
          </section>
          {dropZone('Choose conversations.json. It stays in your browser.')}
        </div>
      )}

      {view === 'cursor' && (
        <div className="space-y-6">
          <section aria-labelledby="cursor-export-title" className="bg-slate-900/60 border border-white/10 rounded-2xl p-6 space-y-4">
            <h2 id="cursor-export-title" className="text-xl font-bold text-white flex items-center gap-2">
              <Download className="w-5 h-5 text-sky-300" aria-hidden="true" /> Export your Cursor usage
            </h2>
            <ol className="space-y-3 text-sm text-slate-200 list-decimal list-inside">
              <li>
                Sign in at{' '}
                <a href="https://cursor.com/dashboard" target="_blank" rel="noopener noreferrer" className="text-sky-300 hover:text-sky-200 inline-flex items-center gap-1">
                  cursor.com/dashboard <ExternalLink className="w-3 h-3" aria-hidden="true" /><span className="sr-only">(opens in a new tab)</span>
                </a>.
              </li>
              <li>Open <strong className="text-white">Usage</strong> and choose <strong className="text-white">Export CSV</strong>.</li>
              <li>Choose the downloaded <strong className="text-white">.csv</strong> file below.</li>
            </ol>
            <p className="text-sm text-slate-200 bg-amber-500/10 border border-amber-500/30 rounded-lg p-3">
              Cursor's "auto" model doesn't say which model answered, so that use can't be priced. The answer then shows a minimum.
            </p>
          </section>
          {dropZone('Choose the Cursor usage .csv. It stays in your browser.')}
        </div>
      )}

      {view === 'file' && dropZone('Choose the usage_report.json made by `llm-usage-analyzer scan`. It stays in your browser.')}

      <p className="text-xs text-slate-400 text-center">
        Independent project. Not affiliated with Anthropic, OpenAI, Google or Cursor.
      </p>
    </div>
  );
};

export default Uploader;
