// Prices and plans for the CLI. Keep in sync with services/pricing.ts at the repo root.
// USD per 1M tokens, from Anthropic's and OpenAI's public pricing pages (checked 2026-10-09).
// Anything not listed is reported as "unpriced" instead of guessed.

export interface ModelPrice {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface TokenCounts {
  input: number;
  output: number;
  cache_read?: number;
  cache_write?: number;
}

// multiplier = Pro's usage allowance per 5-hour window (Max 5x = 5x Pro, Max 20x = 20x Pro)
export const PLANS = {
  'Claude Pro': { price: 20, multiplier: 1 },
  'Claude Max 5x': { price: 100, multiplier: 5 },
  'Claude Max 20x': { price: 200, multiplier: 20 },
} as const;

export type PlanKey = keyof typeof PLANS;

export const PLAN_KEYS = Object.keys(PLANS) as PlanKey[];

// Short names for the command line
export const PLAN_SHORT: Record<string, PlanKey> = {
  pro: 'Claude Pro',
  max5x: 'Claude Max 5x',
  max20x: 'Claude Max 20x',
};

const claude = (input: number, output: number, readMultiplier = 0.1): ModelPrice => ({
  input,
  output,
  cacheRead: input * readMultiplier,
  cacheWrite: input * 1.25,
});

const PRICES: Record<string, ModelPrice> = {
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
  // Haiku 5.5 prompts over 100K tokens cost more; this uses the lower rate.
  'claude-haiku-5-5': { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
  'claude-haiku-4-5': claude(1, 5),
  'claude-3-5-haiku': claude(0.8, 4),
  'gpt-4o': { input: 2.5, output: 10, cacheRead: 1.25, cacheWrite: 0 },
  'gpt-4o-mini': { input: 0.15, output: 0.6, cacheRead: 0.075, cacheWrite: 0 },
  o1: { input: 15, output: 60, cacheRead: 7.5, cacheWrite: 0 },
};

const KEYS_LONGEST_FIRST = Object.keys(PRICES).sort((a, b) => b.length - a.length);

export function priceFor(model: string): ModelPrice | null {
  for (const key of KEYS_LONGEST_FIRST) {
    if (model === key || model.startsWith(key + '-')) return PRICES[key];
  }
  return null;
}

export function tokenCost(model: string, t: TokenCounts): { cost: number; priced: boolean } {
  const p = priceFor(model);
  if (!p) return { cost: 0, priced: false };
  const cost =
    (t.input * p.input +
      t.output * p.output +
      (t.cache_read || 0) * p.cacheRead +
      (t.cache_write || 0) * p.cacheWrite) / 1_000_000;
  return { cost, priced: true };
}

export function costByModel(byModel: Record<string, TokenCounts>): {
  cost: number;
  unpricedModels: string[];
} {
  let cost = 0;
  const unpricedModels: string[] = [];
  for (const [model, t] of Object.entries(byModel)) {
    const r = tokenCost(model, t);
    if (r.priced) cost += r.cost;
    else unpricedModels.push(model);
  }
  return { cost, unpricedModels };
}
