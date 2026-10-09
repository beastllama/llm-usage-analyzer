// Copy of services/pricing.ts for the CLI. Generated from the root module: keep them identical.
// USD per 1M tokens. Anything not listed is reported as unpriced instead of guessed.

export interface ModelPrice {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;   // 5-minute cache writes
  cacheWrite1h: number; // 1-hour cache writes
}

export interface TokenCounts {
  input: number;
  output: number;
  cache_read?: number;
  cache_write?: number;     // 5-minute cache writes
  cache_write_1h?: number;  // 1-hour cache writes
}

// Claude subscription plans. "multiplier" is Pro's usage allowance per 5-hour window:
// Max 5x = 5x Pro, Max 20x = 20x Pro (Anthropic help center).
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

// Longest keys are matched first, so "claude-opus-5-5-..." resolves to "claude-opus-5-5", not "claude-opus-5".
// null means the family is known but no verified price is, so the model is reported as unpriced.
const PRICES: Record<string, ModelPrice | null> = {
  'claude-fable-5-1': claude(10, 50, 0.025),
  'claude-opus-5-5': claude(4, 20, 0.05),
  'claude-opus-5': claude(5, 25),
  'claude-opus-4-8': claude(5, 25),
  'claude-opus-4-7': claude(5, 25),
  'claude-opus-4-6': claude(5, 25),
  'claude-opus-4-5': claude(5, 25),
  'claude-sonnet-5-5': claude(2, 10, 0.05),
  'claude-sonnet-5': claude(2, 10),
  'claude-sonnet-4-6': claude(3, 15),
  'claude-sonnet-4-5': claude(3, 15),
  // Haiku 5.5 prompts over 100K tokens cost more ($0.50/$2.50). This table uses the lower rate,
  // so long-prompt Haiku usage is underestimated.
  'claude-haiku-5-5': { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125, cacheWrite1h: 0.2 },
  'claude-haiku-4-5': claude(1, 5),
  // Retired model, last listed price.
  'claude-3-5-haiku': claude(0.8, 4),
  // OpenAI (cached input is billed at the cached rate; OpenAI has no cache-write charge).
  'gpt-4o': { input: 2.5, output: 10, cacheRead: 1.25, cacheWrite: 0, cacheWrite1h: 0 },
  'gpt-4o-mini': { input: 0.15, output: 0.6, cacheRead: 0.075, cacheWrite: 0, cacheWrite1h: 0 },
  // o1 shuts down October 23, 2026. Its variants have no verified price here, so they are not guessed.
  'o1': { input: 15, output: 60, cacheRead: 7.5, cacheWrite: 0, cacheWrite1h: 0 },
  'o1-mini': null,
  'o1-preview': null,
  'o1-pro': null,
};

const KEYS_LONGEST_FIRST = Object.keys(PRICES).sort((a, b) => b.length - a.length);

export function priceFor(model: string): ModelPrice | null {
  for (const key of KEYS_LONGEST_FIRST) {
    if (model === key || model.startsWith(key + '-')) return PRICES[key];
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

// Short names for the command line
export const PLAN_SHORT: Record<string, PlanKey> = {
  pro: "Claude Pro",
  max5x: "Claude Max 5x",
  max20x: "Claude Max 20x",
};
