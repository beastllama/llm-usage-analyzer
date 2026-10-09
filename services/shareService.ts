import { UsageReport } from '../types';
import { MonthlyComparison, UsagePattern, formatTokenNumber, formatUsd } from './analysisService';

/**
 * Plain text the user can copy. Nothing here is sent anywhere by the app:
 * the user decides where to paste it.
 */

/** A question to paste into Claude, ChatGPT, Gemini, or any other assistant. Numbers only. */
export function buildAiQuestion(report: UsageReport, cmp: MonthlyComparison, pattern: UsagePattern): string {
  return [
    'I want to decide between a Claude subscription and pay-as-you-go API use. Please answer in 3 short sentences, in plain words.',
    '',
    `My plan: ${cmp.planKey}, ${formatUsd(cmp.planPrice)} per month.`,
    `The same usage at pay-as-you-go list prices: about ${formatUsd(cmp.apiCostMonthly)} per month.`,
    `Tokens in this period: ${formatTokenNumber(report.usage.tokens.input)} in, ${formatTokenNumber(report.usage.tokens.output)} out.`,
    `I was active on ${pattern.activeDays} of ${pattern.periodDays} days.`,
    '',
    'Which is cheaper for me, and what should I do next?',
  ].join('\n');
}

/** One line to share. Says what the numbers are and where they came from. */
export function buildShareLine(cmp: MonthlyComparison): string {
  const verdict = cmp.verdict === 'keep'
    ? `my ${cmp.planKey} plan (${formatUsd(cmp.planPrice)}/mo) costs less than pay-as-you-go (about ${formatUsd(cmp.apiCostMonthly)}/mo at list prices)`
    : `pay-as-you-go would cost about ${formatUsd(cmp.apiCostMonthly)}/mo at list prices, less than my ${cmp.planKey} plan (${formatUsd(cmp.planPrice)}/mo)`;
  return `I checked my Claude usage: ${verdict}. Checked locally with LLM Usage Analyzer: https://github.com/beastllama/llm-usage-analyzer`;
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
