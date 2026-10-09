#!/usr/bin/env node
import { program } from 'commander';
import { scanCommand } from './commands/scan.js';
import { analyzeCommand } from './commands/analyze.js';
import { serveCommand } from './commands/serve.js';
import { statuslineCommand } from './commands/statusline.js';
import { limitsCommand } from './commands/limits.js';

const VERSION = '1.0.0';

program
  .name('llm-usage')
  .description('See whether your Claude subscription costs more or less than pay-as-you-go')
  .version(VERSION);

program.addCommand(scanCommand);
program.addCommand(analyzeCommand);
program.addCommand(serveCommand);
program.addCommand(statuslineCommand);
program.addCommand(limitsCommand);

program.action(() => {
  console.log(`
  🔍 LLM Usage Analyzer v${VERSION}

  Start here:
    scan        Read Claude Code history and write usage_report.json
    analyze     Compare pay-as-you-go cost with each Claude plan

  Live limits (Pro and Max):
    statusline  Claude Code status line. Shows your live 5-hour and weekly %
    limits      Downgrade check from those readings

  Dashboard:
    serve       Run a localhost server the web dashboard can read

  Examples:
    $ llm-usage scan                     # all history, plus saved older days
    $ llm-usage scan --days 30           # last 30 days only
    $ llm-usage analyze                  # compare with each plan
    $ llm-usage limits --plan max20x     # would a lower plan have fit?

  Run any command with --help for more.
  `);
});

program.parse();
