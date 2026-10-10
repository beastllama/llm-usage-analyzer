import { UsageReport } from '../types';
import { MonthlyComparison, UsagePattern, formatTokenNumber } from './analysisService';
import { describeCaveats, planLabel } from './answer';
import { formatApproxUsd, formatAtLeastUsd, formatUsd } from './format';

/**
 * Plain text the user can copy. Nothing here is sent anywhere by the app:
 * the user decides where to paste it.
 */

const LINK = 'https://github.com/beastllama/llm-usage-analyzer';

/** The pay-as-you-go cost per month, in words that say whether it is an estimate or a minimum. */
const apiPerMonth = (cmp: MonthlyComparison): string =>
  cmp.lowerBound ? `at least ${formatAtLeastUsd(cmp.apiCostMonthly)}` : `about ${formatApproxUsd(cmp.apiCostMonthly)}`;

/**
 * A question to paste into Claude, ChatGPT, Gemini, or any other assistant. Numbers, plan names and the names of
 * models that have no price. `assumed` marks a plan the person never chose.
 */
export function buildAiQuestion(report: UsageReport, cmp: MonthlyComparison, pattern: UsagePattern, assumed = false): string {
  return [
    `I want to decide between a ${cmp.product.name} subscription and pay-as-you-go API use. Please answer in 3 short sentences, in plain words.`,
    '',
    `My plan: ${planLabel(cmp.planKey, assumed)}, ${formatUsd(cmp.planPrice)} per month.`,
    `The same usage at pay-as-you-go list prices: ${apiPerMonth(cmp)} per month.`,
    `Tokens in this period: ${formatTokenNumber(report.usage.tokens.input)} in, ${formatTokenNumber(report.usage.tokens.output)} out.`,
    `I was active on ${pattern.activeDays} of ${pattern.periodDays} days.`,
    ...describeCaveats(cmp).map((c) => `Note: ${c}`),
    '',
    'Which is cheaper for me, and what should I do next?',
  ].join('\n');
}

/**
 * One line to share. Says what the numbers are and where they came from.
 * Returns null when the data does not support a statement (no answer yet), so nothing misleading is offered.
 */
export function buildShareLine(cmp: MonthlyComparison, assumed = false): string | null {
  const plan = `${cmp.planKey} plan (${formatUsd(cmp.planPrice)}/mo${assumed ? ', assumed' : ''})`;
  const api = `${apiPerMonth(cmp)}/mo`;
  // "at least" already says it is a minimum. Anything else is an estimate.
  const basis = cmp.lowerBound ? api : `${api}, an estimate`;
  const tail = `Checked on my own computer with LLM Usage Analyzer: ${LINK}`;
  switch (cmp.verdict) {
    case 'keep':
      return `My ${plan} looks cheaper than pay-as-you-go (${basis}). ${tail}`;
    case 'switch':
      return `Pay-as-you-go looks cheaper than my ${plan} (${basis}). ${tail}`;
    case 'tie':
      return `My ${plan} and pay-as-you-go cost about the same (an estimate). ${tail}`;
    default:
      return null;
  }
}

/** Copy text to the clipboard. Returns false if the browser refuses. */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
