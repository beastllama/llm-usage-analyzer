import { Command } from 'commander';
import chalk from 'chalk';
import { readSamples, downgradeCheck, HEADROOM, limitsFile } from '../limits.js';
import { PLANS, PLAN_SHORT } from '../pricing.js';

const MIN_SAMPLES_FOR_A_VERDICT = 50;

export const limitsCommand = new Command('limits')
  .description('Downgrade check from your recorded 5-hour limit readings (Pro and Max)')
  .option('-p, --plan <plan>', 'Your current plan: pro, max5x or max20x')
  .option('-d, --days <number>', 'Look back this many days', (v) => parseInt(v, 10), 30)
  .action((options: { plan?: string; days: number }) => {
    if (!Number.isInteger(options.days) || options.days < 1) {
      console.error(chalk.red('\n❌ --days must be a whole number, 1 or more.\n'));
      process.exit(1);
    }
    const planKey = options.plan ? PLAN_SHORT[options.plan.toLowerCase()] : undefined;
    if (!planKey) {
      console.error(chalk.red('\n❌ Tell me your current plan: --plan pro, --plan max5x or --plan max20x\n'));
      process.exit(1);
    }

    const since = Date.now() - options.days * 24 * 60 * 60 * 1000;
    const samples = readSamples().filter(s => s.ts >= since);

    console.log(chalk.cyan(`\n📉 Downgrade check · ${planKey} · last ${options.days} days\n`));

    if (samples.length === 0) {
      console.log(chalk.yellow('   No readings yet.'));
      console.log(chalk.gray('   Add `llm-usage-analyzer statusline` as your Claude Code status line, then use Claude Code for a few days.'));
      console.log(chalk.gray(`   Readings are saved to ${limitsFile()}\n`));
      return;
    }

    const peak = samples.reduce((best, s) => (s.five_hour > best.five_hour ? s : best));
    const when = new Date(peak.ts).toLocaleString();
    console.log(`   Peak 5-hour usage: ${chalk.white(`${Math.round(peak.five_hour)}%`)} of your window ${chalk.gray(`(${when})`)}`);
    console.log(chalk.gray(`   Readings used: ${samples.length}`));

    if (samples.length < MIN_SAMPLES_FOR_A_VERDICT) {
      console.log(chalk.yellow(`   Only ${samples.length} readings. Keep the status line on for longer for a fair check.`));
    }

    const current = PLANS[planKey];
    const lower = (Object.keys(PLANS) as Array<keyof typeof PLANS>)
      .filter(k => PLANS[k].multiplier < current.multiplier)
      .sort((a, b) => PLANS[b].multiplier - PLANS[a].multiplier);

    console.log(chalk.white('\n   Would a lower plan have fit this peak?'));
    if (lower.length === 0) {
      console.log(chalk.gray(`   ${planKey} is already the lowest plan.\n`));
      return;
    }

    const rows = downgradeCheck(peak.five_hour, current.multiplier, lower.map(k => ({ plan: k, multiplier: PLANS[k].multiplier })));
    for (const row of rows) {
      const pct = `${Math.round(row.neededPercent)}%`;
      const verdict = row.fits
        ? chalk.green(`yes, it would use about ${pct} of that window`)
        : chalk.red(`no, it would need about ${pct} of that window`);
      console.log(`     ${row.plan.padEnd(16)} ${verdict}`);
    }

    console.log(chalk.gray(`\n   "Fits" means under ${Math.round(HEADROOM * 100)}% of the lower plan's window (this tool's rule).`));
    console.log(chalk.gray('   Based on Anthropic\'s published multipliers (Pro 1x, Max 5x, Max 20x) and 5-hour windows only.'));
    console.log(chalk.gray('   Weekly limits are not included. A peak can be missed if the status line was not open.\n'));
  });
