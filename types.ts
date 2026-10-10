export interface TokenUsage {
  input: number;
  output: number;
  cached?: number;
  // input excludes cache tokens; cache reads and writes are priced separately
  by_model: Record<string, { input: number; output: number; cache_read?: number; cache_write?: number; cache_write_1h?: number }>;
}

/** What the person pays for: the subscription a report is compared with. */
export type ProductId = 'claude' | 'chatgpt' | 'gemini-api' | 'cursor';

export interface UsageReport {
  /** Who made the models. Cursor runs models from several makers, so its reports say 'other'. */
  provider: 'anthropic' | 'openai' | 'google' | 'xai' | 'other';
  /** The subscription this usage counts against. Reports from before this field existed are Claude when the provider is Anthropic. */
  product?: ProductId;
  /** The tool the numbers were read from, for example "Claude Code" or "Codex CLI". */
  tool?: string;
  source: 'local_agent' | 'browser_extension' | 'api' | 'manual_upload' | 'demo' | 'manual_entry';
  period: {
    start: string; // ISO Date string
    end: string;   // ISO Date string
  };
  plan: {
    name: string;
    price_usd: number;
    type: 'subscription' | 'payg';
  };
  usage: {
    tokens: TokenUsage;
    messages: {
      count: number;
      by_day: Array<{ date: string; count: number; input: number; output: number }>;
      /** Replies whose log never recorded how they ended, so their output count may be cut short. */
      unfinished?: number;
    };
    sessions: {
      count: number;
    };
    /** True when some logs could not be read (for example compressed files on an older Node), so the totals are a minimum. */
    incomplete?: boolean;
    /**
     * Charges beyond the plan that the tool's own export shows for this period (Cursor's on-demand use), in USD.
     * `rows_without_cost` counts on-demand rows whose cost the export did not give, so the real amount is higher.
     */
    on_demand?: { usd: number; rows: number; rows_without_cost: number };
  };
}

// Storage types for localStorage persistence
export interface StoredReport {
  id: string;
  report: UsageReport;
  savedAt: string; // ISO Date string
  name: string;    // The dates the report covers, so two reports are never named alike
}

// Trend analysis types
export interface TrendData {
  period: string; // "2024-01" for monthly
  totalTokens: number;
  totalCost: number;
  inputTokens: number;
  outputTokens: number;
  messageCount: number;
  sessionCount: number;
  activeDays: number;
}

export interface UsageTrend {
  data: TrendData[];
  percentChange: number | null; // vs previous month; null when the latest month is too short to compare
  avgDailyCost: number;
  projectedMonthlyCost: number;
  /** How many saved reports the figures use. Reports with no priced usage, and reports that overlap a newer one, are left out. */
  reportsUsed: number;
  /** True when some usage has no known price and is left out of the costs. */
  hasUnpriced: boolean;
  /** True when any report used here has a pay-as-you-go cost that is only a minimum (cut-short replies or unpriced models). */
  lowerBound: boolean;
}
