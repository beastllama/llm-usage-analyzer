import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import * as fs from 'fs';
import * as path from 'path';
import { formatTokens, parseLocalDate } from '../parsers/common.js';
import { READERS, buildAllReports, readersWithData, toBundle, type BuiltReport } from '../report.js';
import { historyDir } from '../history.js';
import { costByModel } from '../pricing.js';
import { estimateQuality } from '../estimate.js';
import { insideGitRepo, plain, writePrivateFile } from '../fsafe.js';
import { wholeNumber } from '../args.js';
import type { ScanOptions } from '../types.js';

const money = (n: number) => (n > 0 && n < 0.01 ? '<$0.01' : `$${n.toFixed(2)}`);

export const scanCommand = new Command('scan')
  .description('Read Claude Code, Codex CLI and Gemini CLI history and write usage_report.json')
  .option('-d, --days <number>', 'Only include the last N days', wholeNumber)
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

    const readers = readersWithData();
    if (readers.length === 0) {
      console.error(chalk.red('\n❌ No Claude Code, Codex CLI or Gemini CLI history found.'));
      for (const reader of READERS) console.error(chalk.gray(`   Looked in: ${reader.dataPath()}`));
      console.error(chalk.gray(`   Use one of these tools at least once, or set ${READERS.map((r) => r.envVar).join(', ')} to where it keeps its data.\n`));
      process.exit(1);
    }

    if (options.json) {
      const built = await buildAllReports({ ...options, save: options.save !== false });
      // The reports go to stdout. Anything else goes to stderr, so a pipe gets clean JSON.
      for (const b of built) {
        if (b.historyWarning) console.error(`${b.reader.tool}: ${plain(b.historyWarning)}`);
        if (b.historySaveError) console.error(`${b.reader.tool}: could not save your history (${plain(b.historySaveError)}). This scan still worked.`);
      }
      console.log(JSON.stringify(toBundle(built.map((b) => b.report)), null, 2));
      return;
    }

    console.log(chalk.cyan('\n🔍 LLM Usage Analyzer · scan\n'));
    for (const reader of readers) console.log(chalk.gray(`   Reading ${reader.tool}: ${reader.dataPath()}`));
    if (options.days) console.log(chalk.gray(`   Period: last ${options.days} days`));
    else if (options.startDate || options.endDate) {
      console.log(chalk.gray(`   Period: ${options.startDate || 'start'} to ${options.endDate || 'today'}`));
    }
    console.log('');

    const spinner = ora('Reading...').start();
    const built = await buildAllReports({ ...options, save: options.save !== false }, (reader, p) => {
      spinner.text = `Reading ${reader.tool}... ${p.filesProcessed} files, ${p.messagesProcessed} replies`;
    });
    spinner.stop();

    for (const b of built) printSummary(b, options.verbose === true);

    if (built.every((b) => b.report.usage.messages.count === 0)) {
      console.log(chalk.gray('   Nothing to save.\n'));
      return;
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

    // The report is personal. Say so before it is written into a folder that is under git.
    if (insideGitRepo(path.dirname(outputPath))) {
      console.log(chalk.yellow('\n   The report is about to be written into a git repository. It is personal, so do not commit it.'));
    }

    // Personal data, so only the owner can read it
    writePrivateFile(outputPath, JSON.stringify(toBundle(built.map((b) => b.report)), null, 2));

    console.log('');
    console.log(chalk.gray('   ' + '─'.repeat(40)));
    console.log(chalk.green(`   📄 Saved: ${plain(outputPath)}`));
    if (options.save !== false) {
      console.log(chalk.gray(`   🗂  History: ${historyDir()}`));
    }
    console.log(chalk.gray('   Open the dashboard and drop this file in, or run `llm-usage-analyzer analyze`.\n'));
  });

/** What one tool's scan found, in a few lines. */
function printSummary(built: BuiltReport, verbose: boolean): void {
  const { reader, report, progress, historyDaysAdded, historySaveError, historyWarning } = built;
  console.log(chalk.white.bold(`   ${reader.tool}`));
  if (historyWarning) console.log(chalk.yellow(`   ⚠️  ${plain(historyWarning)}`));
  if (historySaveError) {
    console.log(chalk.yellow(`   ⚠️  Could not save your history (${plain(historySaveError)}). This scan still worked. Use --no-save to hide this.`));
  }
  if (verbose && progress.errors.length > 0) {
    console.log(chalk.yellow('   ⚠️  Some files were skipped:'));
    // File and folder names come from the disk, so they are cleaned before they reach the terminal
    progress.errors.slice(0, 5).forEach((err) => console.log(chalk.gray(`      ${plain(err).slice(0, 300)}`)));
    if (progress.errors.length > 5) console.log(chalk.gray(`      …and ${progress.errors.length - 5} more`));
  }

  if (report.usage.messages.count === 0) {
    console.log(chalk.yellow('   No usage found in this period.\n'));
    return;
  }

  const totalTokens = report.usage.tokens.input + report.usage.tokens.output;
  const { cost, unpricedModels } = costByModel(report.usage.tokens.by_model);
  const quality = estimateQuality(report);
  const days = report.usage.messages.by_day.length;
  const costText = quality.pricedTokens === 0 ? 'not known (no model has a known price)'
    : quality.lowerBound ? `at least ${money(cost)}` : money(cost);

  console.log(`   ${chalk.white('Replies:')}       ${report.usage.messages.count}  ${chalk.gray(`(${days} active days)`)}`);
  console.log(`   ${chalk.white('Input:')}         ${chalk.cyan(formatTokens(report.usage.tokens.input))}`);
  const outputNote = quality.unfinishedReplies > 0 ? chalk.gray('  (a minimum: some replies were logged before they finished)') : '';
  console.log(`   ${chalk.white('Output:')}        ${chalk.cyan(formatTokens(report.usage.tokens.output))}${outputNote}`);
  console.log(`   ${chalk.white('Total:')}         ${chalk.cyan(formatTokens(totalTokens))}`);
  if (report.usage.tokens.cached) {
    console.log(`   ${chalk.white('Cache:')}         ${chalk.gray(formatTokens(report.usage.tokens.cached))}`);
  }
  console.log(`   ${chalk.white('Pay-as-you-go:')} ${chalk.cyan(costText)} ${chalk.gray('at list prices, for this period')}`);
  console.log(`   ${chalk.white('Period:')}        ${new Date(report.period.start).toLocaleDateString()} to ${new Date(report.period.end).toLocaleDateString()}`);

  if (historyDaysAdded > 0) {
    console.log(chalk.green(`   + ${historyDaysAdded} older day${historyDaysAdded === 1 ? '' : 's'} from your saved history`));
  }
  if (progress.duplicatesSkipped > 0) {
    console.log(chalk.gray(`   Counted ${progress.messagesProcessed} replies. Skipped ${progress.duplicatesSkipped} repeated log lines.`));
  }
  if (quality.unfinishedReplies > 0) {
    const percent = Math.round(quality.unfinishedShare * 100);
    console.log(chalk.yellow(`   ${quality.unfinishedReplies} repl${quality.unfinishedReplies === 1 ? 'y was' : 'ies were'} logged before finishing (${percent}%). Their output is undercounted.`));
    if (quality.lowerBound) console.log(chalk.yellow('   So the cost above is a minimum. The real cost is higher.'));
  }
  if (unpricedModels.length > 0) {
    console.log(chalk.yellow(`   No known price for: ${unpricedModels.map((m) => plain(m).slice(0, 80)).join(', ')} (left out of the cost)`));
  }
  console.log('');
}
