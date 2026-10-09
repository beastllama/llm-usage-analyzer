// Single source of truth for prices and plans.
// Prices are USD per 1M tokens, from Anthropic's public pages, checked on PRICES_CHECKED:
//   API prices and cache multipliers: https://platform.claude.com/docs/en/about-claude/pricing
//   Plan prices (monthly, before tax): https://claude.com/pricing
// Anything not listed here is shown as "unpriced" instead of guessed.

export interface ModelPrice {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;   // 5-minute cache writes
  cacheWrite1h: number; // 1-hour cache writes
}

/** The day the prices below were last compared with Anthropic's pages. Shown to the user. */
export const PRICES_CHECKED = '2026-10-09';

export interface TokenCounts {
  input: number;
  output: number;
  cache_read?: number;
  cache_write?: number;     // 5-minute cache writes
  cache_write_1h?: number;  // 1-hour cache writes
}

// Claude subscription plans, at their monthly list price before tax (https://claude.com/pricing).
// "multiplier" is Pro's usage allowance per 5-hour session: Max 5x = 5x Pro, Max 20x = 20x Pro
// (https://support.claude.com/en/articles/11049741-what-is-the-max-plan).
export const PLANS = {
  'Claude Pro': { price: 20, multiplier: 1 },
  'Claude Max 5x': { price: 100, multiplier: 5 },
  'Claude Max 20x': { price: 200, multiplier: 20 },
} as const;

export type PlanKey = keyof typeof PLANS;

export const PLAN_KEYS = Object.keys(PLANS) as PlanKey[];

const isPlanKey = (value: unknown): value is PlanKey =>
  typeof value === 'string' && (PLAN_KEYS as string[]).includes(value);

export const toPlanKey = (value: unknown): PlanKey | null => (isPlanKey(value) ? value : null);

// Cache multipliers: 5-minute cache writes cost 1.25x input; cache reads cost 0.1x input,
// except 0.05x on Opus 5.5 and Sonnet 5.5 and 0.025x on Fable 5.1 (Anthropic pricing page).
// 1-hour cache writes cost 2x input (Anthropic pricing page, checked 2026-10-09).
const claude = (input: number, output: number, readMultiplier = 0.1): ModelPrice => ({
  input,
  output,
  cacheRead: input * readMultiplier,
  cacheWrite: input * 1.25,
  cacheWrite1h: input * 2,
});

// null means the family is known but no verified price is, so the model is reported as unpriced.
const PRICES: Record<string, ModelPrice | null> = {
  'claude-fable-5-1': claude(10, 50, 0.025),
  'claude-fable-5': claude(10, 50),
  // Mythos models have limited availability. Same prices as Fable.
  'claude-mythos-5-1': claude(10, 50, 0.025),
  'claude-mythos-5': claude(10, 50),
  'claude-opus-5-5': claude(4, 20, 0.05),
  'claude-opus-5': claude(5, 25),
  'claude-opus-4-8': claude(5, 25),
  'claude-opus-4-7': claude(5, 25),
  'claude-opus-4-6': claude(5, 25),
  'claude-opus-4-5': claude(5, 25),
  // Retired on the API, still in old logs. Last listed price.
  'claude-opus-4-1': claude(15, 75),
  'claude-opus-4': claude(15, 75),
  'claude-sonnet-5-5': claude(2, 10, 0.05),
  'claude-sonnet-5': claude(2, 10),
  'claude-sonnet-4-6': claude(3, 15),
  'claude-sonnet-4-5': claude(3, 15),
  'claude-sonnet-4': claude(3, 15),
  'claude-haiku-5-5': { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125, cacheWrite1h: 0.2 },
  // Haiku 5.5 requests whose prompt is over 100K tokens are billed at this rate for the whole request.
  // The CLI parser files those requests under this key.
  'claude-haiku-5-5-long-prompt': { input: 0.5, output: 2.5, cacheRead: 0.05, cacheWrite: 0.625, cacheWrite1h: 1 },
  'claude-haiku-4-5': claude(1, 5),
  // Retired model, last listed price.
  'claude-3-5-haiku': claude(0.8, 4),
};

// A model id is a table key, optionally followed by a date (-20250929), "-latest", or a context tag like [1m].
// Anything else, for example a newer "claude-opus-5-6", is unpriced. It is not guessed to cost the same as an older model.
const ID_SUFFIX = /^(-\d{8})?(-latest)?(\[[a-z0-9]+\])?$/;

export function priceFor(model: string): ModelPrice | null {
  for (const key of Object.keys(PRICES)) {
    if (model.startsWith(key) && ID_SUFFIX.test(model.slice(key.length))) return PRICES[key];
  }
  return null;
}

/** USD cost for one model's token counts. priced=false means no price is known, so cost is 0. */
export function tokenCost(model: string, t: TokenCounts): { cost: number; priced: boolean } {
  const p = priceFor(model);
  if (!p) return { cost: 0, priced: false };
  const cost =
    (t.input * p.input +
      t.output * p.output +
      (t.cache_read || 0) * p.cacheRead +
      (t.cache_write || 0) * p.cacheWrite +
      (t.cache_write_1h || 0) * p.cacheWrite1h) / 1_000_000;
  return { cost, priced: true };
}

/** Total tokens of every kind, for counting what could not be priced. */
export function totalTokens(t: TokenCounts): number {
  return t.input + t.output + (t.cache_read || 0) + (t.cache_write || 0) + (t.cache_write_1h || 0);
}

/** Total USD cost across a by_model map, plus the tokens that had no known price. */
export function costByModel(byModel: Record<string, TokenCounts>): {
  cost: number;
  unpricedTokens: number;
  unpricedModels: string[];
} {
  let cost = 0;
  let unpricedTokens = 0;
  const unpricedModels: string[] = [];
  for (const [model, t] of Object.entries(byModel)) {
    const r = tokenCost(model, t);
    if (r.priced) {
      cost += r.cost;
    } else {
      unpricedTokens += totalTokens(t);
      unpricedModels.push(model);
    }
  }
  return { cost, unpricedTokens, unpricedModels };
}
