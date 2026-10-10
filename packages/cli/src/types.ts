// Shared types for CLI - mirrors main app types (types.ts at the repo root)

export interface TokenUsage {
  input: number;
  output: number;
  cached?: number;
  // input excludes cache tokens; cache_read and cache_write are priced separately
  by_model: Record<string, { input: number; output: number; cache_read?: number; cache_write?: number; cache_write_1h?: number }>;
}

export interface DayUsage {
  date: string; // YYYY-MM-DD, local calendar day
  count: number; // replies (one per API response)
  input: number;
  output: number;
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
      by_day: DayUsage[];
      /** Replies whose log never recorded how they ended, so their output count may be cut short. */
      unfinished?: number;
    };
    sessions: {
      count: number;
    };
  };
}

// One line of a Claude Code transcript. Only the fields the scanner reads.
export interface ClaudeMessage {
  parentUuid?: string;
  sessionId?: string;
  requestId?: string;
  timestamp?: string;
  /** Claude Code marks a placeholder row for an API error. It is not a billed reply. */
  isApiErrorMessage?: boolean;
  message?: {
    id?: string;
    model?: string;
    role?: string;
    /** Null while a reply is still streaming. Set when the reply has ended. */
    stop_reason?: string | null;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_creation_input_tokens?: number;
      cache_read_input_tokens?: number;
      cache_creation?: {
        ephemeral_5m_input_tokens?: number;
        ephemeral_1h_input_tokens?: number;
      };
    };
  };
}

// Status-line JSON that Claude Code sends on stdin. Only the rate-limit fields are used.
export interface StatusLineInput {
  session_id?: string;
  rate_limits?: {
    five_hour?: { used_percentage?: number; resets_at?: number };
    seven_day?: { used_percentage?: number; resets_at?: number };
  };
}

export interface ScanOptions {
  days?: number;
  startDate?: string;
  endDate?: string;
  output?: string;
  json?: boolean;
  verbose?: boolean;
  /** Keep days from earlier scans, because Claude Code deletes transcripts after 30 days by default. */
  history?: boolean;
}
