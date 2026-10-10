// What people pay for, and the plans each one has. Shared by the web app and the CLI (the CLI gets a copy:
// run "npm run sync:pricing"). Plan prices are monthly, before tax, from each company's own pricing page, on the
// date in `checked`. Nothing here is guessed: a plan whose price could not be checked is not listed.
import { PLANS } from './pricing';

/** The same list as ProductId in types.ts (a test checks that they match). */
export type ProductId = 'claude' | 'chatgpt' | 'gemini-api' | 'cursor';

export interface Plan {
  /** Shown as it is, for example "ChatGPT Plus". */
  name: string;
  /** USD per month, before tax. */
  price: number;
}

export interface Product {
  id: ProductId;
  /** The subscription, as people say it: "Claude", "ChatGPT". */
  name: string;
  /** The tools whose numbers are counted against it, for sentences like "from your Codex CLI history". */
  tools: string;
  /** Whose published API prices the pay-as-you-go estimate uses, as in "an estimate from Anthropic's published prices". */
  pricesFrom: string;
  /** Cheapest first. The answer assumes `defaultPlan` until the person picks theirs. */
  plans: Plan[];
  defaultPlan: string;
  /** One plain sentence about usage limits, checked like the prices. */
  limitsNote: string;
  /**
   * True when no plan covers this tool, so its use is already billed at API prices (Gemini CLI since June 18, 2026).
   * Then there is no plan to compare with: the estimate is what the use costs.
   */
  payAsYouGo?: boolean;
  plansSource: string;
  checked: string;
}

export const PRODUCTS: Record<ProductId, Product> = {
  claude: {
    id: 'claude',
    name: 'Claude',
    tools: 'Claude Code',
    pricesFrom: "Anthropic's",
    plans: (Object.keys(PLANS) as Array<keyof typeof PLANS>).map((name) => ({ name, price: PLANS[name].price })),
    defaultPlan: 'Claude Pro',
    limitsNote: "Plans also differ in how much you can use. Anthropic doesn't publish exact limits.",
    plansSource: 'https://claude.com/pricing',
    checked: '2026-10-09',
  },
  chatgpt: {
    id: 'chatgpt',
    name: 'ChatGPT',
    tools: 'Codex CLI',
    pricesFrom: "OpenAI's",
    // The plans that include the Codex CLI. Free and Go don't (https://learn.chatgpt.com/docs/pricing.md).
    // Pro comes at three prices. Business is per user, billed monthly ($20 billed annually, 2+ users).
    plans: [
      { name: 'ChatGPT Plus', price: 20 },
      { name: 'ChatGPT Business', price: 25 },
      { name: 'ChatGPT Pro ($100)', price: 100 },
      { name: 'ChatGPT Pro ($200)', price: 200 },
      { name: 'ChatGPT Pro ($500)', price: 500 },
    ],
    defaultPlan: 'ChatGPT Plus',
    limitsNote: 'Plans also differ in how much Codex use they include.',
    plansSource: 'https://learn.chatgpt.com/docs/pricing.md',
    checked: '2026-10-10',
  },
  'gemini-api': {
    id: 'gemini-api',
    name: 'Gemini API',
    tools: 'Gemini CLI',
    pricesFrom: "Google's",
    // https://developers.google.com/gemini-code-assist/docs/deprecations/code-assist-individuals
    plans: [],
    defaultPlan: '',
    limitsNote: 'Since June 18, 2026, Google AI Pro and Ultra no longer cover Gemini CLI. It is billed at Gemini API prices.',
    payAsYouGo: true,
    plansSource: 'https://developers.google.com/gemini-code-assist/docs/deprecations/code-assist-individuals',
    checked: '2026-10-10',
  },
  cursor: {
    id: 'cursor',
    name: 'Cursor',
    tools: 'Cursor',
    pricesFrom: "the model makers'",
    plans: [
      { name: 'Cursor Pro', price: 20 },
      { name: 'Cursor Pro+', price: 60 },
      { name: 'Cursor Ultra', price: 200 },
    ],
    defaultPlan: 'Cursor Pro',
    // "Individual plans include at least $20 of usage each month (more on higher tiers)" (cursor.com/blog/increased-agent-usage);
    // "If you exceed your included usage, additional requests are billed at API rates with no markup" (cursor.com/help)
    limitsNote: 'Each plan includes some model use (at least $20 a month at API prices on Pro). Use beyond that is billed at API prices.',
    plansSource: 'https://cursor.com/pricing',
    checked: '2026-10-10',
  },
};

export const PRODUCT_IDS = Object.keys(PRODUCTS) as ProductId[];

/** The product a tool's report counts against, by the tool's name. */
export const PRODUCT_OF_TOOL: Record<string, ProductId> = {
  'Claude Code': 'claude',
  'claude.ai': 'claude',
  'Codex CLI': 'chatgpt',
  'Gemini CLI': 'gemini-api',
  Cursor: 'cursor',
};

/** The product a report counts against. Reports saved before products existed are Claude reports when they are Anthropic's. */
export function productOf(report: { product?: string; provider: string }): Product | null {
  if (report.product) return (PRODUCTS as Record<string, Product | undefined>)[report.product] ?? null;
  return report.provider === 'anthropic' ? PRODUCTS.claude : null;
}

/** A plan of this product, by its name, or null. */
export function findPlan(product: Product, name: unknown): Plan | null {
  return typeof name === 'string' ? product.plans.find((p) => p.name === name) ?? null : null;
}

/** The plan to use: the named one when this product has it, else the product's default. */
export function planOrDefault(product: Product, name: unknown): Plan | null {
  return findPlan(product, name) ?? findPlan(product, product.defaultPlan) ?? product.plans[0] ?? null;
}
