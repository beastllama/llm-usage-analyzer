import { Command } from 'commander';
import { runStatusline } from './statusline-run.js';

/**
 * Status line for Claude Code. (The work is in statusline-run.ts. Running `llm-usage-analyzer statusline` goes
 * straight there, without loading the rest of the program. This definition is for the help text.)
 */
export const statuslineCommand = new Command('statusline')
  .description('Claude Code status-line command: shows live limit % and records it (Pro and Max)')
  .action(async () => {
    await runStatusline();
  });
