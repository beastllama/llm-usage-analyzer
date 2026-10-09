import { Command } from 'commander';
import chalk from 'chalk';
import { createServer, IncomingMessage, ServerResponse } from 'http';
import { claudeDataExists, getClaudeDataPath } from '../parsers/claude.js';
import { buildReport } from '../report.js';

const DEFAULT_PORT = 3456;
// Listens on loopback only, so other computers on the network cannot reach it
const BIND_HOST = '127.0.0.1';

// Pages allowed to read the data: only the dashboard's own dev and preview ports.
// Any other local page is refused. Add a dashboard elsewhere with --origin.
export const DEFAULT_ORIGINS = [
  'http://localhost:5173',
  'http://localhost:4173',
  'http://127.0.0.1:5173',
  'http://127.0.0.1:4173',
];

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

const collect = (value: string, previous: string[] = []) => [...previous, value];

export const serveCommand = new Command('serve')
  .description('Start a local server that the web dashboard reads from (localhost only)')
  .option('-p, --port <number>', `Port to listen on (default: ${DEFAULT_PORT})`, parseInt)
  .option('-d, --days <number>', 'Only include the last N days', parseInt)
  .option('--origin <url>', 'Extra dashboard address allowed to read data (repeatable)', collect, [])
  .action(async (options: { port?: number; days?: number; origin: string[] }) => {
    const port = options.port || DEFAULT_PORT;
    const allowlist = [...DEFAULT_ORIGINS, ...options.origin];

    if (!claudeDataExists()) {
      console.error(chalk.red('\n  Claude Code data not found.'));
      console.error(chalk.gray(`  Expected location: ${getClaudeDataPath()}`));
      console.error(chalk.gray('  Use Claude Code at least once, or set CLAUDE_CONFIG_DIR.\n'));
      process.exit(1);
    }

    console.log(chalk.cyan('\n  LLM Usage Analyzer · local server\n'));
    console.log(chalk.gray(`  Reading: ${getClaudeDataPath()}`));
    if (options.days) console.log(chalk.gray(`  Period: last ${options.days} days`));
    console.log('');

    const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
      const url = req.url?.split('?')[0];
      const origin = allowedOrigin(req.headers.origin, allowlist);

      // Block requests whose Host header is not this server (DNS rebinding)
      if (!isAllowedHost(req.headers.host, port)) {
        res.statusCode = 403;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'Forbidden host' }));
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
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Cache-Control', 'no-store');

      if (req.method === 'OPTIONS') {
        res.statusCode = origin ? 204 : 403;
        res.end();
        return;
      }

      if (req.method !== 'GET') {
        res.statusCode = 405;
        res.end(JSON.stringify({ error: 'Only GET is allowed' }));
        return;
      }

      if (url === '/api/health') {
        res.end(JSON.stringify({ status: 'ok', timestamp: new Date().toISOString() }));
        console.log(chalk.gray(`  ${new Date().toLocaleTimeString()} GET /api/health - 200`));
      } else if (url === '/api/usage') {
        try {
          const { report } = await buildReport({ days: options.days, save: false });
          res.end(JSON.stringify(report));
          console.log(chalk.green(`  ${new Date().toLocaleTimeString()} GET /api/usage - 200 (${report.usage.messages.count} replies)`));
        } catch (error) {
          res.statusCode = 500;
          res.end(JSON.stringify({ error: 'Could not read usage data' }));
          console.log(chalk.red(`  ${new Date().toLocaleTimeString()} GET /api/usage - 500 ${error}`));
        }
      } else {
        res.statusCode = 404;
        res.end(JSON.stringify({ error: 'Not found' }));
      }
    });

    server.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        console.error(chalk.red(`\n  Port ${port} is already in use.`));
        console.error(chalk.gray(`  Stop the other program, or run: llm-usage serve --port ${port + 1}\n`));
      } else {
        console.error(chalk.red(`\n  Could not start the server: ${err.message}\n`));
      }
      process.exit(1);
    });

    server.listen(port, BIND_HOST, () => {
      console.log(chalk.green(`  Running at http://localhost:${port} (this computer only)`));
      console.log(chalk.gray(`  Allowed dashboards: ${allowlist.join(', ')}`));
      console.log(chalk.gray('  Press Ctrl+C to stop.\n'));
    });

    process.on('SIGINT', () => {
      console.log(chalk.gray('\n  Stopping...'));
      server.close(() => process.exit(0));
    });
  });
