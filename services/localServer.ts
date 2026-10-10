import type { UsageReport } from '../types';
import { reportsIn } from './fileImport';

/**
 * The dashboard reaches the CLI's local server one of two ways:
 *  - served by the CLI itself (npx llm-usage-analyzer): same origin, so no address is needed
 *  - opened on this computer by the dev server: the CLI's default address
 * The CLI marks the page it serves with a meta tag.
 *
 * A public website must not probe localhost on its own: Chrome asks the visitor for permission when a
 * public page contacts their computer. So a page on a public host never looks for a local server.
 */
export const servedByCli: boolean =
  typeof document !== 'undefined' && document.querySelector('meta[name="llm-usage-server"]') !== null;

export const LOCAL_SERVER_URL: string = servedByCli ? '' : 'http://localhost:3456';

const LOOPBACK_HOSTS = ['localhost', '127.0.0.1', '[::1]', '::1'];

/** True when this page is itself served from this computer (the dev server, or the CLI). */
export const pageIsLocal: boolean =
  typeof location !== 'undefined' && LOOPBACK_HOSTS.includes(location.hostname);

export const NO_HISTORY_MESSAGE = 'No Claude Code, Codex CLI or Gemini CLI history found on this computer. Using claude.ai or Cursor instead? Choose that option below.';
export const STOPPED_MESSAGE = "Can't reach the analyzer. It may have stopped. Run npx llm-usage-analyzer again.";

export type UsageFetch =
  | { ok: true; reports: UsageReport[] }
  | { ok: false; reason: 'no-history' | 'stopped' | 'unreadable'; message: string };

/** Let go of a response whose body is not needed. The browser keeps the request open until its body is read or dropped. */
const release = (res: Response): void => {
  res.body?.cancel().catch(() => { /* already closed */ });
};

/** Ask the local server for the user's usage, and check the answer before anything draws it. */
export async function fetchLocalUsage(timeoutMs = 120_000): Promise<UsageFetch> {
  let res: Response;
  try {
    res = await fetch(`${LOCAL_SERVER_URL}/api/usage`, { signal: AbortSignal.timeout(timeoutMs) });
  } catch {
    return { ok: false, reason: 'stopped', message: STOPPED_MESSAGE };
  }
  if (res.status === 404) {
    release(res);
    return { ok: false, reason: 'no-history', message: NO_HISTORY_MESSAGE };
  }
  if (!res.ok) {
    release(res);
    return { ok: false, reason: 'unreadable', message: "The analyzer couldn't read your history. Run it again, or use a file instead." };
  }
  try {
    const json: unknown = await res.json();
    const reports = reportsIn(json);
    if (reports) return { ok: true, reports };
  } catch {
    // fall through
  }
  return { ok: false, reason: 'unreadable', message: "The analyzer sent something this page can't read. Run it again, or use a file instead." };
}

/** True when the local server answers its health check. */
export async function localServerIsUp(timeoutMs = 5000): Promise<boolean> {
  try {
    const res = await fetch(`${LOCAL_SERVER_URL}/api/health`, { signal: AbortSignal.timeout(timeoutMs) });
    release(res);
    return res.ok;
  } catch {
    return false;
  }
}
