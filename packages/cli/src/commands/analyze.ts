import { Command } from 'commander';
import chalk from 'chalk';
import * as fs from 'fs';
import * as path from 'path';
import type { UsageReport } from '../types.js';
import { formatTokens } from '../parsers/claude.js';
import { PLANS, PLAN_KEYS, PRICES_CHECKED, costByModel } from '../pricing.js';
import { decide, estimateQuality, MINIMUM_SHARE } from '../estimate.js';
import { plain } from '../fsafe.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Calendar days covered, inclusive, on the user's clock. */
function spanDays(start: string, end: string): number {
  const s = new Date(start);
  const e = new Date(end);
  if (Number.isNaN(s.getTime()) || Number.isNaN(e.getTime())) return 1;
  const a = Date.UTC(s.getFullYear(), s.getMonth(), s.getDate());
  const b = Date.UTC(e.getFullYear(), e.getMonth(), e.getDate());
  return Math.max(1, Math.round((b - a) / DAY_MS) + 1);
}

const money = (n: number) => (n > 0 && n < 0.01 ? '<$0.01' : `$${n.toFixed(2)}`);

export const analyzeCommand = new Command('analyze')
  .description('Compare pay-as-you-go cost with each Claude plan, using usage_report.json')
  .argument('[file]', 'Usage report file', 'usage_report.json')
  .action(async (file: string) => {
    const inputPath = path.resolve(file);

    if (!fs.existsSync(inputPath)) {
      console.error(chalk.red(`\n❌ File not found: ${inputPath}`));
      console.error(chalk.gray('   Run `llm-usage-analyzer scan` first.\n'));
      process.exit(1);
    }

    let report: UsageReport;
    try {
      report = JSON.parse(fs.readFileSync(inputPath, 'utf-8'));
      if (!report?.usage?.tokens?.by_model || !report.period) throw new Error('missing fields');
    } catch {
      console.error(chalk.red(`\n❌ Not a usage report: ${inputPath}`));
      console.error(chalk.gray('   Run `llm-usage-analyzer scan` to make one.\n'));
      process.exit(1);
    }

    const { cost, unpricedModels } = costByModel(report.usage.tokens.by_model);
    const pricedModels = Object.keys(report.usage.tokens.by_model).length - unpricedModels.length;
    if (pricedModels === 0) {
      console.log(chalk.yellow(`\n   None of the models in this report have a known price: ${unpricedModels.map(plain).join(', ')}`));
      console.log(chalk.gray('   No plan comparison is shown, because it would have no basis.\n'));
      return;
    }
    const days = spanDays(report.period.start, report.period.end);
    const monthly = cost * (30 / days);
    const quality = estimateQuality(report);
    const atLeast = quality.lowerBound ? 'at least ' : '';
    const totalTokens = report.usage.tokens.input + report.usage.tokens.output;

    console.log(chalk.cyan('\n📊 Pay-as-you-go vs your plan\n'));
    console.log(chalk.gray(`   ${formatTokens(totalTokens)} tokens over ${days} day${days === 1 ? '' : 's'}`));
    console.log('');
    console.log(`   Pay-as-you-go: ${chalk.white(`${atLeast}${money(cost)}`)} for this period`);
    console.log(`                  ${chalk.cyan(quality.lowerBound ? `at least ${money(monthly)} per month` : `≈ ${money(monthly)} per month`)} ${chalk.gray('(list prices)')}`);

    if (days < 7) {
      console.log(chalk.yellow(`\n   ⚠️  Only ${days} day${days === 1 ? '' : 's'} of data. This monthly figure is a rough guess.`));
    }
    if (quality.unfinishedShare > MINIMUM_SHARE) {
      console.log(chalk.yellow(`\n   ⚠️  ${Math.round(quality.unfinishedShare * 100)}% of replies were logged before they finished, so their output is undercounted.`));
    }
    if (quality.unpricedTokens > 0) {
      console.log(chalk.yellow(`\n   ⚠️  Some usage is from models with no known price (${unpricedModels.map(plain).join(', ')}). The cost above leaves it out.`));
    }
    if (quality.lowerBound) {
      console.log(chalk.yellow('   So the pay-as-you-go cost is a minimum. The real cost is higher. A minimum can show that a plan is the better deal, but not that pay-as-you-go is.'));
    }

    console.log(chalk.white('\n   Your plans, per month:'));
    for (const key of PLAN_KEYS) {
      const price = PLANS[key].price;
      const diff = Math.abs(price - monthly);
      const verdict = decide(price, monthly, quality.lowerBound);
      const line = verdict === 'keep'
        ? chalk.green(`cheaper than pay-as-you-go by ${atLeast}${money(diff)}`)
        : verdict === 'tie'
          ? chalk.white('about the same as pay-as-you-go')
          : verdict === 'unknown'
            ? chalk.yellow(`can't tell: pay-as-you-go would cost at least ${money(monthly)}`)
            : chalk.yellow(`${money(diff)} more than pay-as-you-go`);
      console.log(`     ${key.padEnd(16)} ${money(price).padStart(8)}   ${line}`);
    }

    console.log(chalk.gray('\n   Price only: a cheaper plan may not give you enough usage.'));
    console.log(chalk.gray(`   Estimate at list prices checked ${PRICES_CHECKED}. Anthropic does not publish the size of plan limits.`));
    console.log(chalk.gray('   For your real limit use `llm-usage-analyzer statusline` (Pro and Max).\n'));
  });
