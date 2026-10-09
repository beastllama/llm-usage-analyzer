// The words of the answer, in one place. The screen, the exports, the share note and the AI question
// all use this, so they can never disagree about what the numbers allow us to say.
import type { MonthlyComparison } from './analysisService';
import { MINIMUM_SHARE } from './estimate';
import { formatApproxUsd, formatAtLeastUsd, formatUsd, plain } from './format';

/** A plan as it should read in copied text and files: marked when the person never said which plan they pay for. */
export const planLabel = (plan: string, assumed: boolean): string => (assumed ? `${plan} (assumed)` : plan);

export interface Answer {
  /** One sentence. */
  headline: string;
  /** One short sentence with the numbers. */
  detail: string;
  /** Plain sentences about what makes the answer weaker. Empty when there is nothing to warn about. */
  caveats: string[];
  tone: 'keep' | 'switch' | 'tie' | 'unknown';
}

/** "A, B and C", with at most three names. */
function nameList(names: string[]): string {
  const clean = names.map((n) => plain(n).replace(/^claude-/, ''));
  if (clean.length <= 3) return clean.length > 1 ? `${clean.slice(0, -1).join(', ')} and ${clean[clean.length - 1]}` : clean[0] ?? '';
  return `${clean.slice(0, 3).join(', ')} and ${clean.length - 3} more`;
}

/** Why the cost is only a minimum, or what was left out. */
export function describeCaveats(cmp: MonthlyComparison): string[] {
  const q = cmp.quality;
  const out: string[] = [];
  if (cmp.lowConfidence) out.push('Early guess: there is under a week of data.');
  if (q.unfinishedShare > MINIMUM_SHARE) {
    out.push(`${Math.round(q.unfinishedShare * 100)}% of your replies were logged before they finished, so the real cost is higher.`);
  }
  // Any usage with no price makes the cost a minimum: nothing says how much it would have added
  if (q.unpricedTokens > 0) {
    out.push(`We have no price for ${nameList(cmp.unpricedModels)}, so the real cost is higher.`);
  }
  return out;
}

export function describeAnswer(cmp: MonthlyComparison): Answer {
  const caveats = describeCaveats(cmp);
  const plan = cmp.planKey;
  const estimate = "This is an estimate from Anthropic's published prices.";

  switch (cmp.verdict) {
    case 'keep':
      return {
        tone: 'keep',
        headline: `Your ${plan} plan costs less than pay-as-you-go.`,
        detail: cmp.lowerBound
          ? `At least ${formatAtLeastUsd(cmp.difference)} a month less. The real gap is bigger.`
          : `About ${formatApproxUsd(cmp.difference)} a month less. ${estimate}`,
        caveats,
      };
    case 'switch':
      return {
        tone: 'switch',
        headline: `Pay-as-you-go would cost less than your ${plan} plan.`,
        detail: `About ${formatApproxUsd(cmp.difference)} a month less. ${estimate}`,
        caveats,
      };
    case 'tie':
      return {
        tone: 'tie',
        headline: 'Too close to call.',
        detail: `Your ${plan} plan is ${formatUsd(cmp.planPrice)} a month. Pay-as-you-go would be about ${formatApproxUsd(cmp.apiCostMonthly)}.`,
        caveats,
      };
    default:
      return {
        tone: 'unknown',
        headline: "We can't say yet.",
        detail: `Pay-as-you-go would cost at least ${formatAtLeastUsd(cmp.apiCostMonthly)} a month. Your ${plan} plan is ${formatUsd(cmp.planPrice)}.`,
        caveats,
      };
  }
}
