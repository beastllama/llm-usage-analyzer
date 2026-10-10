import { Command } from 'commander';
import chalk from 'chalk';
import * as fs from 'fs';
import * as path from 'path';
import type { UsageReport } from '../types.js';
import { formatTokens } from '../parsers/common.js';
import { PRICES_CHECKED, costByModel } from '../pricing.js';
import { productOf } from '../products.js';
import { BUNDLE_FORMAT } from '../report.js';
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
  .description('Compare pay-as-you-go cost with your plans, using usage_report.json')
  .argument('[file]', 'Usage report file', 'usage_report.json')
  .action(async (file: string) => {
    const inputPath = path.resolve(file);

    if (!fs.existsSync(inputPath)) {
      console.error(chalk.red(`\n❌ File not found: ${inputPath}`));
      console.error(chalk.gray('   Run `llm-usage-analyzer scan` first.\n'));
      process.exit(1);
    }

    let reports: UsageReport[];
    try {
      const json = JSON.parse(fs.readFileSync(inputPath, 'utf-8'));
      // A file from scan holds one report per tool. A file from an older version holds one report.
      reports = json?.format === BUNDLE_FORMAT && Array.isArray(json.reports) ? json.reports : [json];
      if (reports.length === 0 || reports.some((r) => !r?.usage?.tokens?.by_model || !r.period)) throw new Error('missing fields');
    } catch {
      console.error(chalk.red(`\n❌ Not a usage report: ${inputPath}`));
      console.error(chalk.gray('   Run `llm-usage-analyzer scan` to make one.\n'));
      process.exit(1);
    }

    for (const report of reports) analyzeOne(report);
    console.log(chalk.gray(`   Estimates at list prices checked ${PRICES_CHECKED}. Price only: a cheaper plan may not give you enough usage.\n`));
  });

function analyzeOne(report: UsageReport): void {
  const product = productOf(report);
  const tool = plain(report.tool ?? product?.tools ?? 'Unknown tool');
  console.log(chalk.cyan(`\n📊 ${tool}\n`));

  const { cost, unpricedModels } = costByModel(report.usage.tokens.by_model);
  const pricedModels = Object.keys(report.usage.tokens.by_model).length - unpricedModels.length;
  if (pricedModels === 0) {
    console.log(chalk.yellow(`   None of the models in this report have a known price: ${unpricedModels.map(plain).join(', ') || 'no models'}`));
    console.log(chalk.gray('   No comparison is shown, because it would have no basis.'));
    return;
  }
  const days = spanDays(report.period.start, report.period.end);
  const monthly = cost * (30 / days);
  const quality = estimateQuality(report);
  const atLeast = quality.lowerBound ? 'at least ' : '';
  const totalTokens = report.usage.tokens.input + report.usage.tokens.output;

  console.log(chalk.gray(`   ${formatTokens(totalTokens)} tokens over ${days} day${days === 1 ? '' : 's'}`));
  console.log(`   Pay-as-you-go: ${chalk.white(`${atLeast}${money(cost)}`)} for this period`);
  console.log(`                  ${chalk.cyan(quality.lowerBound ? `at least ${money(monthly)} per month` : `≈ ${money(monthly)} per month`)} ${chalk.gray(`(${product?.pricesFrom ?? 'list'} list prices)`)}`);

  if (days < 7) {
    console.log(chalk.yellow(`   ⚠️  Only ${days} day${days === 1 ? '' : 's'} of data. This monthly figure is a rough guess.`));
  }
  if (quality.unfinishedShare > MINIMUM_SHARE) {
    console.log(chalk.yellow(`   ⚠️  ${Math.round(quality.unfinishedShare * 100)}% of replies were logged before they finished, so their output is undercounted.`));
  }
  if (quality.unpricedTokens > 0) {
    console.log(chalk.yellow(`   ⚠️  Some usage is from models with no known price (${unpricedModels.map(plain).join(', ')}). The cost above leaves it out.`));
  }
  if (quality.lowerBound) {
    console.log(chalk.yellow('   So the pay-as-you-go cost is a minimum. The real cost is higher. A minimum can show that a plan is the better deal, but not that pay-as-you-go is.'));
  }

  if (!product) {
    console.log(chalk.gray('   This report is not from a tool with plans to compare with.'));
    return;
  }
  if (product.payAsYouGo) {
    console.log(chalk.white(`\n   ${product.limitsNote}`));
    return;
  }

  console.log(chalk.white(`\n   ${product.name} plans, per month:`));
  const width = Math.max(...product.plans.map((p) => p.name.length)) + 2;
  for (const plan of product.plans) {
    const diff = Math.abs(plan.price - monthly);
    const verdict = decide(plan.price, monthly, quality.lowerBound);
    const line = verdict === 'keep'
      ? chalk.green(`cheaper than pay-as-you-go by ${atLeast}${money(diff)}`)
      : verdict === 'tie'
        ? chalk.white('about the same as pay-as-you-go')
        : verdict === 'unknown'
          ? chalk.yellow(`can't tell: pay-as-you-go would cost at least ${money(monthly)}`)
          : chalk.yellow(`${money(diff)} more than pay-as-you-go`);
    console.log(`     ${plan.name.padEnd(width)} ${money(plan.price).padStart(8)}   ${line}`);
  }
  console.log(chalk.gray(`   ${product.limitsNote}`));
  if (product.id === 'claude') console.log(chalk.gray('   For your real limit use `llm-usage-analyzer statusline` (Pro and Max).'));
}
