// How far to trust a pay-as-you-go estimate, and what it is allowed to say.
// Shared by the web app and the CLI (the CLI gets a copy: run "npm run sync:pricing").
import { costByModel, totalTokens, type TokenCounts } from './pricing';

/** The part of a report this file reads. Both the web app and the CLI report have it. */
export interface EstimateInput {
  usage: {
    tokens: { by_model: Record<string, TokenCounts> };
    messages: { count: number; unfinished?: number };
  };
}

/**
 * When more than this share of the replies were logged before they finished, the pay-as-you-go cost is a
 * minimum, not an estimate: those replies' output counts may be cut short. Up to this share the error is small
 * next to the "tie" band below, which is why a few such replies do not turn the answer into a minimum.
 *
 * Tokens from a model with no known price are different. Nothing bounds what they would have cost (a new model can
 * cost 50 times more than a cheap one), so ANY such token makes the cost a minimum.
 */
export const MINIMUM_SHARE = 0.05;

export interface EstimateQuality {
  replies: number;
  /** Replies whose log never recorded how they ended. */
  unfinishedReplies: number;
  unfinishedShare: number;
  pricedTokens: number;
  unpricedTokens: number;
  unpricedShare: number;
  /** The pay-as-you-go cost is a minimum, because enough of the usage is cut short or unpriced. */
  lowerBound: boolean;
}

export function estimateQuality(report: EstimateInput): EstimateQuality {
  const byModel = report.usage.tokens.by_model;
  const { unpricedTokens } = costByModel(byModel);
  const allTokens = Object.values(byModel).reduce((sum, t) => sum + totalTokens(t), 0);
  const pricedTokens = allTokens - unpricedTokens;

  const replies = report.usage.messages.count;
  const unfinishedReplies = Math.min(replies, Math.max(0, report.usage.messages.unfinished || 0));
  const unfinishedShare = replies > 0 ? unfinishedReplies / replies : 0;
  const unpricedShare = allTokens > 0 ? unpricedTokens / allTokens : 0;

  return {
    replies,
    unfinishedReplies,
    unfinishedShare,
    pricedTokens,
    unpricedTokens,
    unpricedShare,
    lowerBound: unfinishedShare > MINIMUM_SHARE || unpricedTokens > 0,
  };
}

/**
 * keep:    the plan costs less than pay-as-you-go
 * switch:  pay-as-you-go would cost less
 * tie:     within a dollar or 5% of the plan price, so the answer is "about the same"
 * unknown: the cost is only a minimum and the plan is cheaper than that minimum, so nothing can be said
 */
export type Verdict = 'keep' | 'switch' | 'tie' | 'unknown';

/** Within this many dollars per month, the plan and pay-as-you-go count as the same. */
export const tieBand = (planPrice: number): number => Math.max(1, planPrice * 0.05);

export function decide(planPrice: number, apiCostMonthly: number, lowerBound: boolean): Verdict {
  // A minimum can only prove the plan is the better deal. It can never show that pay-as-you-go is.
  if (lowerBound) return planPrice <= apiCostMonthly ? 'keep' : 'unknown';
  if (Math.abs(planPrice - apiCostMonthly) < tieBand(planPrice)) return 'tie';
  return planPrice < apiCostMonthly ? 'keep' : 'switch';
}
