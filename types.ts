export interface TokenUsage {
  input: number;
  output: number;
  cached?: number;
  // input excludes cache tokens; cache reads and writes are priced separately
  by_model: Record<string, { input: number; output: number; cache_read?: number; cache_write?: number; cache_write_1h?: number }>;
}

export interface UsageReport {
  provider: 'anthropic' | 'openai' | 'google' | 'xai' | 'other';
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
  };
}

export interface PlanPricing {
  name: string;
  provider: string;
  type: 'subscription' | 'payg';
  price_monthly_flat?: number;
  pricing_model?: {
    input_per_1m: number;
    output_per_1m: number;
    // Simple fallback for unknown models
  };
}

export interface AnalysisResult {
  currentMonthlyCost: number;
  apiEquivalentCost: number;
  savings: number;
  isOverpaying: boolean;
  recommendedPlan: string;
  modelBreakdown: Array<{ name: string; value: number }>;
}

// Storage types for localStorage persistence
export interface StoredReport {
  id: string;
  report: UsageReport;
  savedAt: string; // ISO Date string
  name?: string;   // User-friendly label
}

export interface UserSettings {
  currentPlan?: {
    provider: string;
    name: string;
    price_usd: number;
  };
  theme?: 'light' | 'dark';
  lastSyncedAt?: string;
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
  /** How many saved reports the figures use. Reports that overlap a newer one are left out. */
  reportsUsed: number;
  /** True when some usage has no known price and is left out of the costs. */
  hasUnpriced: boolean;
}
