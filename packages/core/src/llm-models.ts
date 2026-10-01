/**
 * Model catalogue and price table (USD per million tokens). Cost per agent
 * step is priced from here, so budgets are enforced in dollars.
 */
export type ModelInfo = {
  id: string;
  label: string;
  provider: 'anthropic';
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** Supports adaptive thinking and `output_config.effort`. */
  adaptive: boolean;
  /** Supports the server-side refusal fallback (`fallbacks: "default"`). */
  fallbacks: boolean;
  /** Web search server tool variant this model accepts. */
  webSearchTool: 'web_search_20260209' | 'web_search_20250305';
};

export const MODELS: ModelInfo[] = [
  { id: 'claude-opus-5-5', label: 'Claude Opus 5.5', provider: 'anthropic', input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5, adaptive: true, fallbacks: true, webSearchTool: 'web_search_20260209' },
  { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5', provider: 'anthropic', input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5, adaptive: true, fallbacks: true, webSearchTool: 'web_search_20260209' },
  { id: 'claude-fable-5-1', label: 'Claude Fable 5.1', provider: 'anthropic', input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5, adaptive: true, fallbacks: true, webSearchTool: 'web_search_20250305' },
  { id: 'claude-opus-5', label: 'Claude Opus 5', provider: 'anthropic', input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25, adaptive: true, fallbacks: true, webSearchTool: 'web_search_20260209' },
  { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5', provider: 'anthropic', input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25, adaptive: false, fallbacks: false, webSearchTool: 'web_search_20250305' },
];

export const DEFAULT_MODEL = 'claude-opus-5-5';
/** Server-side web search is billed per search. */
export const WEB_SEARCH_USD_PER_REQUEST = 0.01;

export function modelInfo(id: string): ModelInfo {
  return MODELS.find((m) => m.id === id) ?? MODELS[0];
}

export type Usage = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  webSearchRequests: number;
};

export const ZERO_USAGE: Usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, webSearchRequests: 0 };

export function priceUsage(modelId: string, u: Usage): number {
  const m = modelInfo(modelId);
  const cost =
    (u.inputTokens * m.input + u.outputTokens * m.output + u.cacheReadTokens * m.cacheRead + u.cacheWriteTokens * m.cacheWrite) / 1_000_000 +
    u.webSearchRequests * WEB_SEARCH_USD_PER_REQUEST;
  return Math.round(cost * 1_000_000) / 1_000_000;
}
