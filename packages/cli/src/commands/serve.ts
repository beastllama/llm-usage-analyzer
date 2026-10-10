import { Command } from 'commander';
import chalk from 'chalk';
import { createServer, IncomingMessage, Server, ServerResponse } from 'http';
import { spawn } from 'child_process';
import { pipeline } from 'stream';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { READERS, buildAllReports, readersWithData, toBundle, type UsageBundle } from '../report.js';
import { wholeNumber } from '../args.js';

export const DEFAULT_PORT = 3456;
// How many ports above the default to try when it is busy and the user did not pick one
const PORT_TRIES = 20;
// Listens on loopback only, so other computers on the network cannot reach it
const BIND_HOST = '127.0.0.1';
// A scan result is reused for this long, so a burst of requests costs one scan
const SCAN_CACHE_MS = 2000;

// Pages allowed to read the data from another address: only the dashboard's own dev and preview ports.
// Any other page is refused. Add a self-hosted dashboard address with --origin.
export const DEFAULT_ORIGINS = [
  'http://localhost:5173',
  'http://localhost:4173',
  'http://127.0.0.1:5173',
  'http://127.0.0.1:4173',
];

/**
 * Rules the browser enforces on the page this server hands out.
 * `connect-src 'self'` stops the page's own requests (fetch, XHR, WebSocket) from reaching any other address,
 * and `script-src 'self'` stops injected scripts. This is a second line of defence, not a guarantee:
 * a CSP cannot stop every way a script could send data out (for example by navigating the tab).
 * The first line is that the page carries no code that sends data anywhere.
 */
export const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

/** Only allow the Host header this server actually answers to. Blocks DNS-rebinding attacks. */
export function isAllowedHost(hostHeader: string | undefined, port: number): boolean {
  if (!hostHeader) return false;
  return [`localhost:${port}`, `127.0.0.1:${port}`, `[::1]:${port}`].includes(hostHeader.toLowerCase());
}

/** Return the origin only when it is on the allowlist. Anything else gets no CORS header. */
export function allowedOrigin(origin: string | undefined, allowlist: string[]): string | null {
  if (!origin) return null;
  return allowlist.includes(origin) ? origin : null;
}

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.txt': 'text/plain; charset=utf-8',
};

/** Marks the page as served by this CLI, so the page knows to read its data from the same address. */
const SERVER_MARKER = '<meta name="llm-usage-server" content="1" />';

export function injectServerMarker(html: string): string {
  return html.includes('</head>') ? html.replace('</head>', `    ${SERVER_MARKER}\n  </head>`) : SERVER_MARKER + html;
}

/**
 * Find the file for a URL path inside `root`, or null. Never leaves `root`.
 * A path with no file extension falls back to index.html, so the single-page app can load.
 */
export function resolveStaticFile(root: string, urlPath: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return null;
  }
  if (decoded.includes('\0')) return null;

  const rootReal = fs.realpathSync(root);
  const wanted = path.resolve(rootReal, '.' + path.posix.normalize('/' + decoded));
  const inside = (p: string) => p === rootReal || p.startsWith(rootReal + path.sep);
  if (!inside(wanted)) return null;

  const tryFile = (p: string): string | null => {
    try {
      const real = fs.realpathSync(p);
      return inside(real) && fs.statSync(real).isFile() ? real : null;
    } catch {
      return null;
    }
  };

  const direct = decoded.endsWith('/') ? tryFile(path.join(wanted, 'index.html')) : tryFile(wanted);
  if (direct) return direct;
  return path.extname(decoded) === '' ? tryFile(path.join(rootReal, 'index.html')) : null;
}

/** Where the bundled dashboard lives: next to dist/ when installed, or in the package folder when run from source. */
export function findWebDir(): string | null {
  const here = path.dirname(fileURLToPath(import.meta.url));
  for (const candidate of [path.resolve(here, '../web'), path.resolve(here, '../../web')]) {
    if (fs.existsSync(path.join(candidate, 'index.html'))) return candidate;
  }
  return null;
}

export interface StartOptions {
  /** Port to use. Leave out to use 3456, moving up if it is busy. Use 0 for any free port. */
  port?: number;
  days?: number;
  /** Extra dashboard addresses allowed to read data (advanced: a dashboard you host yourself). */
  origins?: string[];
  /** Also let the dashboard's own dev ports (5173, 4173) read the data. Default true. The one-command launch turns it off. */
  devOrigins?: boolean;
  /** Folder with the built dashboard. null = serve only the data. */
  webDir?: string | null;
  quiet?: boolean;
}

export interface RunningServer {
  server: Server;
  port: number;
  url: string;
  close: () => Promise<void>;
}

function listen(server: Server, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    // A failed attempt leaves its 'listening' callback behind. Drop it so retries do not pile up listeners.
    const onError = (err: Error) => { server.removeAllListeners('listening'); reject(err); };
    server.once('error', onError);
    server.listen(port, BIND_HOST, () => {
      server.off('error', onError);
      const addr = server.address();
      resolve(typeof addr === 'object' && addr ? addr.port : port);
    });
  });
}

export async function startServer(options: StartOptions = {}): Promise<RunningServer> {
  const allowlist = [...(options.devOrigins === false ? [] : DEFAULT_ORIGINS), ...(options.origins ?? [])];
  const webDir = options.webDir === undefined ? findWebDir() : options.webDir;
  const log = (line: string) => { if (!options.quiet) console.log(line); };
  let actualPort = options.port ?? DEFAULT_PORT;

  // One scan at a time, and a fresh answer is reused for a moment. Many requests cannot pile up scans.
  let scanInFlight: Promise<UsageBundle> | null = null;
  let lastScan: { at: number; bundle: UsageBundle } | null = null;
  const currentBundle = (): Promise<UsageBundle> => {
    if (lastScan && Date.now() - lastScan.at < SCAN_CACHE_MS) return Promise.resolve(lastScan.bundle);
    if (!scanInFlight) {
      scanInFlight = buildAllReports({ days: options.days, save: false })
        .then((built) => {
          const bundle = toBundle(built.map((b) => b.report));
          lastScan = { at: Date.now(), bundle };
          return bundle;
        })
        .finally(() => { scanInFlight = null; });
    }
    return scanInFlight;
  };

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = req.url?.split('?')[0] ?? '/';

    const json = (status: number, body: unknown) => {
      res.statusCode = status;
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Cache-Control', 'no-store');
      res.end(JSON.stringify(body));
    };

    // On every answer, including a refusal
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');

    // Block requests whose Host header is not this server (DNS rebinding)
    if (!isAllowedHost(req.headers.host, actualPort)) {
      json(403, { error: 'Forbidden host' });
      return;
    }

    const origin = allowedOrigin(req.headers.origin, allowlist);

    // A request from another website is not wanted here, unless it comes from a dashboard on the allowlist
    // (a dev page on 127.0.0.1 is "cross-site" to localhost, and so is a dashboard you host yourself)
    if (url.startsWith('/api/') && req.headers['sec-fetch-site'] === 'cross-site' && !origin) {
      json(403, { error: 'Forbidden' });
      return;
    }

    if (origin) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
    }
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    // Chrome asks for this when a public page calls a local address
    if (req.headers['access-control-request-private-network'] === 'true' && origin) {
      res.setHeader('Access-Control-Allow-Private-Network', 'true');
    }

    if (req.method === 'OPTIONS') {
      res.statusCode = origin ? 204 : 403;
      res.end();
      return;
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      json(405, { error: 'Only GET is allowed' });
      return;
    }

    if (url === '/api/health') {
      json(200, { status: 'ok', timestamp: new Date().toISOString() });
      return;
    }

    if (url === '/api/usage') {
      if (readersWithData().length === 0) {
        json(404, { error: 'No history found' });
        return;
      }
      try {
        const bundle = await currentBundle();
        json(200, bundle);
        const counts = bundle.reports.map((r) => `${r.usage.messages.count} ${r.tool ?? ''} replies`.replace('  ', ' ')).join(', ');
        log(chalk.gray(`  ${new Date().toLocaleTimeString()} read ${counts}`));
      } catch (error) {
        json(500, { error: 'Could not read usage data' });
        log(chalk.red(`  ${new Date().toLocaleTimeString()} could not read usage data: ${error}`));
      }
      return;
    }

    if (url.startsWith('/api/') || !webDir) {
      json(404, { error: 'Not found' });
      return;
    }

    const file = resolveStaticFile(webDir, url);
    if (!file) {
      json(404, { error: 'Not found' });
      return;
    }

    const isHtml = path.extname(file) === '.html';
    res.statusCode = 200;
    res.setHeader('Content-Type', CONTENT_TYPES[path.extname(file)] ?? 'application/octet-stream');
    res.setHeader('Cache-Control', isHtml ? 'no-store' : 'public, max-age=3600');
    if (isHtml) res.setHeader('Content-Security-Policy', CONTENT_SECURITY_POLICY);
    res.setHeader('X-Frame-Options', 'DENY');

    if (isHtml) {
      const body = injectServerMarker(fs.readFileSync(file, 'utf8'));
      res.setHeader('Content-Length', Buffer.byteLength(body));
      res.end(req.method === 'HEAD' ? undefined : body);
    } else {
      const size = fs.statSync(file).size;
      res.setHeader('Content-Length', size);
      if (req.method === 'HEAD') {
        res.end();
      } else {
        // pipeline closes the file when the other end goes away, so an aborted download cannot leave it open
        pipeline(fs.createReadStream(file), res, () => { /* a reader that left is not an error */ });
      }
    }
  };

  const server = createServer((req, res) => {
    // Whatever goes wrong inside one request must not stop the server
    handle(req, res).catch(() => {
      if (res.headersSent) {
        res.destroy();
      } else {
        res.statusCode = 500;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'Server error' }));
      }
    });
  });

  if (options.port === undefined) {
    // Default port, moving up if it is busy
    let lastError: unknown;
    let bound = false;
    for (let i = 0; i <= PORT_TRIES && !bound; i++) {
      try {
        actualPort = await listen(server, DEFAULT_PORT + i);
        bound = true;
      } catch (err) {
        lastError = err;
        if ((err as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw err;
      }
    }
    if (!bound) throw lastError;
  } else {
    actualPort = await listen(server, options.port);
  }

  return {
    server,
    port: actualPort,
    url: `http://localhost:${actualPort}/`,
    close: () => new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections?.(); }),
  };
}

/**
 * The program that opens an address in the default browser. On macOS and Windows it is given by its full path:
 * Windows looks in the current folder first, so a bare "rundll32" could run a file planted in the folder you start from.
 */
export function browserCommand(
  url: string,
  platform: string = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): [string, string[]] {
  if (platform === 'darwin') return ['/usr/bin/open', [url]];
  if (platform === 'win32') {
    const root = env.SystemRoot || env.windir || 'C:\\Windows';
    return [`${root}\\System32\\rundll32.exe`, ['url.dll,FileProtocolHandler', url]];
  }
  return ['xdg-open', [url]];
}

/** Open an address in the default browser. Fails quietly: the address is printed anyway. */
export function openBrowser(url: string): void {
  const [cmd, args] = browserCommand(url);
  try {
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
    child.on('error', () => {});
    child.unref();
  } catch {
    // The address is printed, so the user can open it by hand
  }
}

export interface LaunchOptions {
  /** The command to suggest when the port is busy. */
  retryCommand?: string;
  port?: number;
  days?: number;
  origins?: string[];
  /** Let the dashboard's own dev ports read the data. Only for developing the dashboard. */
  devOrigins?: boolean;
  open: boolean;
}

/** Start the server, say where it is, and stay running until Ctrl+C. */
export async function launch(options: LaunchOptions): Promise<void> {
  if (options.port !== undefined && (!Number.isInteger(options.port) || options.port < 0 || options.port > 65535)) {
    console.error(chalk.red('\n  --port must be a whole number from 0 to 65535 (for example 3456).\n'));
    process.exit(1);
  }
  if (options.days !== undefined && (!Number.isInteger(options.days) || options.days < 1)) {
    console.error(chalk.red('\n  --days must be a whole number, 1 or more.\n'));
    process.exit(1);
  }
  console.log(chalk.cyan('\n  LLM Usage Analyzer\n'));

  const webDir = findWebDir();
  const found = readersWithData();
  if (found.length === 0) {
    console.log(chalk.yellow('  No Claude Code, Codex CLI or Gemini CLI history found on this computer.'));
    for (const reader of READERS) console.log(chalk.gray(`  Looked in: ${reader.dataPath()}`));
    console.log(chalk.gray('  The page will show how to use a claude.ai export or a Cursor usage file instead.\n'));
  } else {
    for (const reader of found) console.log(chalk.gray(`  Reading ${reader.tool}: ${reader.dataPath()}`));
    if (options.days) console.log(chalk.gray(`  Period: last ${options.days} days`));
  }

  let running: RunningServer;
  try {
    running = await startServer({ port: options.port, days: options.days, origins: options.origins, devOrigins: options.devOrigins, webDir });
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === 'EADDRINUSE') {
      console.error(chalk.red(`\n  Port ${options.port ?? DEFAULT_PORT} is already in use.`));
      console.error(chalk.gray(`  Stop the other program, or try: ${options.retryCommand ?? 'llm-usage-analyzer'} --port ${(options.port ?? DEFAULT_PORT) + 1}\n`));
    } else {
      console.error(chalk.red(`\n  Could not start the server: ${e.message}\n`));
    }
    process.exit(1);
  }

  if (webDir) {
    console.log(chalk.green(`\n  Open ${running.url}`));
    console.log(chalk.gray('  This page runs on your computer only. Nothing is sent anywhere.'));
    if (options.open) openBrowser(running.url);
  } else {
    console.log(chalk.green(`\n  Data server running at ${running.url}`));
    console.log(chalk.gray('  This copy has no dashboard bundled. Start the dashboard from source (npm start).'));
  }
  console.log(chalk.gray('  Press Ctrl+C to stop.\n'));

  process.on('SIGINT', () => {
    console.log(chalk.gray('\n  Stopping...'));
    running.close().then(() => process.exit(0));
  });
}

/**
 * Turn an --origin value into a clean origin like "https://example.com", or null when it is not one.
 * Rejects "null", "*", other schemes, and anything with a path.
 */
export function normalizeOrigin(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    if (url.origin === 'null' || url.username || url.password || url.search || url.hash) return null;
    if (url.pathname !== '/' || value.replace(/\/$/, '') !== url.origin) return null;
    return url.origin;
  } catch {
    return null;
  }
}

const collect = (value: string, previous: string[] = []) => [...previous, value];

export const serveCommand = new Command('serve')
  .description('Start the local server without opening a browser (for developing the dashboard)')
  .option('-p, --port <number>', `Port to listen on (default: ${DEFAULT_PORT})`, wholeNumber)
  .option('-d, --days <number>', 'Only include the last N days', wholeNumber)
  .option('--origin <url>', 'Advanced: extra dashboard address allowed to read data (repeatable)', collect, [])
  .action(async (options: { port?: number; days?: number; origin: string[] }) => {
    const origins: string[] = [];
    for (const value of options.origin) {
      const clean = normalizeOrigin(value);
      if (!clean) {
        console.error(chalk.red(`\n  --origin must look like https://example.com (no path, no *). Got: ${JSON.stringify(value)}\n`));
        process.exit(1);
      }
      origins.push(clean);
    }
    await launch({ port: options.port ?? DEFAULT_PORT, days: options.days, origins, devOrigins: true, open: false, retryCommand: 'llm-usage-analyzer serve' });
  });
