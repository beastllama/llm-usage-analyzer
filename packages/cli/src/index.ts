#!/usr/bin/env node
import { createRequire } from 'module';
import { program } from 'commander';
import chalk from 'chalk';
import { scanCommand } from './commands/scan.js';
import { analyzeCommand } from './commands/analyze.js';
import { serveCommand, launch } from './commands/serve.js';
import { statuslineCommand } from './commands/statusline.js';
import { limitsCommand } from './commands/limits.js';

// Read from package.json so the number printed always matches the number published
const VERSION: string = createRequire(import.meta.url)('../package.json').version;

program
  .name('llm-usage-analyzer')
  .description('See whether your Claude subscription costs more or less than pay-as-you-go')
  .version(VERSION);

program.addCommand(scanCommand);
program.addCommand(analyzeCommand);
program.addCommand(serveCommand);
program.addCommand(statuslineCommand);
program.addCommand(limitsCommand);

program
  .option('-p, --port <number>', 'Port to listen on (default: 3456, or the next free one)', (v) => parseInt(v, 10))
  .option('-d, --days <number>', 'Only include the last N days', (v) => parseInt(v, 10))
  .option('--no-open', 'Do not open the browser');

// With no command: open the dashboard on your own Claude Code history
program.action(async (options: { port?: number; days?: number; open: boolean }) => {
  await launch({ port: options.port, days: options.days, devOrigins: false, open: options.open });
});

program.addHelpText('after', `
Quick start:
  $ npx llm-usage-analyzer             # opens your answer in the browser

More:
  $ llm-usage-analyzer scan                     # write usage_report.json (all history, plus saved older days)
  $ llm-usage-analyzer analyze                  # compare with each plan in the terminal
  $ llm-usage-analyzer limits --plan max20x     # would a lower plan have fit? (Pro and Max)
`);

// Options on the main command only count BEFORE a subcommand name, so `scan --days 5`, `limits -p pro`
// and `serve --port 4411` reach their own commands instead of being swallowed here.
program.enablePositionalOptions();
// `llm-usage-analyzer scna` (a typo) should be an error, not "start the dashboard"
program.allowExcessArguments(false);
// Any unexpected failure (unwritable folder, bad output path...) becomes one plain line, not a stack trace
program.parseAsync().catch((err: unknown) => {
  console.error(chalk.red(`\n  Something went wrong: ${err instanceof Error ? err.message : String(err)}\n`));
  process.exit(1);
});
