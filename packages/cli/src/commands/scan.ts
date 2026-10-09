import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import * as fs from 'fs';
import * as path from 'path';
import {
  claudeDataExists,
  getClaudeDataPath,
  formatTokens,
  parseLocalDate,
} from '../parsers/claude.js';
import { buildReport } from '../report.js';
import { historyFile } from '../history.js';
import { costByModel } from '../pricing.js';
import type { ScanOptions } from '../types.js';

const money = (n: number) => (n > 0 && n < 0.01 ? '<$0.01' : `$${n.toFixed(2)}`);

export const scanCommand = new Command('scan')
  .description('Scan Claude Code local data and write usage_report.json')
  .option('-d, --days <number>', 'Only include the last N days', parseInt)
  .option('--start-date <date>', 'Start date (YYYY-MM-DD)')
  .option('--end-date <date>', 'End date (YYYY-MM-DD, included)')
  .option('-o, --output <file>', 'Output file path (default: usage_report.json)')
  .option('--json', 'Print the report as JSON to stdout (for piping)')
  .option('--no-history', 'Do not add days saved from earlier scans')
  .option('--no-save', 'Do not save this scan to history')
  .option('-v, --verbose', 'Show detailed progress')
  .action(async (options: ScanOptions & { save?: boolean }) => {
    if (options.days !== undefined && (!Number.isInteger(options.days) || options.days < 1)) {
      console.error(chalk.red('\n❌ --days must be a whole number, 1 or more.\n'));
      process.exit(1);
    }
    for (const [flag, value] of [['--start-date', options.startDate], ['--end-date', options.endDate]] as const) {
      if (value && !parseLocalDate(value)) {
        console.error(chalk.red(`\n❌ ${flag} must look like 2026-09-30.\n`));
        process.exit(1);
      }
    }

    if (!claudeDataExists()) {
      console.error(chalk.red('\n❌ Claude Code data not found.'));
      console.error(chalk.gray(`   Expected location: ${getClaudeDataPath()}`));
      console.error(chalk.gray('   Use Claude Code at least once, or set CLAUDE_CONFIG_DIR.\n'));
      process.exit(1);
    }

    if (options.json) {
      const { report } = await buildReport({ ...options, save: options.save !== false });
      console.log(JSON.stringify(report, null, 2));
      return;
    }

    console.log(chalk.cyan('\n🔍 LLM Usage Analyzer · Claude Code scan\n'));
    console.log(chalk.gray(`   Reading: ${getClaudeDataPath()}`));
    if (options.days) console.log(chalk.gray(`   Period: last ${options.days} days`));
    else if (options.startDate || options.endDate) {
      console.log(chalk.gray(`   Period: ${options.startDate || 'start'} to ${options.endDate || 'today'}`));
    }
    console.log('');

    const spinner = ora('Reading transcripts...').start();
    const { report, progress, historyDaysAdded } = await buildReport(
      { ...options, save: options.save !== false },
      (p) => {
        spinner.text = `Reading... ${p.filesProcessed} files, ${p.messagesProcessed} replies`;
      },
    );
    spinner.stop();

    if (options.verbose && progress.errors.length > 0) {
      console.log(chalk.yellow('⚠️  Some files were skipped:'));
      progress.errors.slice(0, 5).forEach((err) => console.log(chalk.gray(`   ${err}`)));
      if (progress.errors.length > 5) console.log(chalk.gray(`   …and ${progress.errors.length - 5} more`));
      console.log('');
    }

    if (report.usage.messages.count === 0) {
      console.log(chalk.yellow('⚠️  No usage found in this period.'));
      console.log(chalk.gray('   Claude Code may not have been used yet, or the dates do not match.\n'));
      return;
    }

    const totalTokens = report.usage.tokens.input + report.usage.tokens.output;
    const { cost, unpricedModels } = costByModel(report.usage.tokens.by_model);
    const days = report.usage.messages.by_day.length;

    console.log(chalk.green('✅ Scan complete\n'));
    console.log(`   ${chalk.white('Replies:')}       ${report.usage.messages.count}  ${chalk.gray(`(${days} active days)`)}`);
    console.log(`   ${chalk.white('Input:')}         ${chalk.cyan(formatTokens(report.usage.tokens.input))}`);
    console.log(`   ${chalk.white('Output:')}        ${chalk.cyan(formatTokens(report.usage.tokens.output))}  ${chalk.gray('(lower bound, see note)')}`);
    console.log(`   ${chalk.white('Total:')}         ${chalk.cyan(formatTokens(totalTokens))}`);
    if (report.usage.tokens.cached) {
      console.log(`   ${chalk.white('Cache:')}         ${chalk.gray(formatTokens(report.usage.tokens.cached))}`);
    }
    console.log(`   ${chalk.white('Pay-as-you-go:')} ${chalk.cyan(money(cost))} ${chalk.gray('at list prices, for this period')}`);
    console.log(`   ${chalk.white('Period:')}        ${new Date(report.period.start).toLocaleDateString()} to ${new Date(report.period.end).toLocaleDateString()}`);

    if (historyDaysAdded > 0) {
      console.log(chalk.green(`\n   + ${historyDaysAdded} older day${historyDaysAdded === 1 ? '' : 's'} from your saved history`));
      console.log(chalk.gray('     (Claude Code deletes transcripts after 30 days by default)'));
    }
    if (progress.duplicatesSkipped > 0) {
      console.log(chalk.gray(`\n   Counted ${progress.messagesProcessed} replies. Skipped ${progress.duplicatesSkipped} repeated log lines.`));
    }
    if (unpricedModels.length > 0) {
      console.log(chalk.yellow(`\n   No known price for: ${unpricedModels.join(', ')} (left out of the cost)`));
    }

    const outputPath = path.resolve(options.output || 'usage_report.json');
    try {
      const existing = fs.lstatSync(outputPath);
      if (existing.isSymbolicLink()) {
        console.error(chalk.red(`\n❌ Refusing to write through a symbolic link: ${outputPath}\n`));
        process.exit(1);
      }
    } catch {
      // File does not exist yet, which is fine
    }

    // Personal data, so only the owner can read it
    fs.writeFileSync(outputPath, JSON.stringify(report, null, 2), { mode: 0o600 });
    fs.chmodSync(outputPath, 0o600);

    console.log('');
    console.log(chalk.gray('   ' + '─'.repeat(40)));
    console.log(chalk.green(`   📄 Saved: ${outputPath}`));
    if (options.save !== false) {
      console.log(chalk.gray(`   🗂  History: ${historyFile()}`));
    }
    console.log(chalk.gray('   Open the dashboard and drop this file in, or run `llm-usage analyze`.\n'));
  });
