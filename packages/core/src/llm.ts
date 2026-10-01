import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import type { z } from 'zod';
import { ProviderError, RateLimitedError } from './errors';
import { DEFAULT_MODEL, modelInfo, type Usage } from './llm-models';

/**
 * LLM provider layer. The canonical transcript format is the Claude Messages
 * API content-block format (Claude is the default provider); another provider
 * plugs in by implementing `LlmProvider` and translating at its boundary.
 */
export type LlmMessage = Anthropic.Beta.BetaMessageParam;
export type LlmContentBlock = Anthropic.Beta.BetaContentBlock;
export type LlmTool = Anthropic.Beta.BetaToolUnion;
export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export type LlmRequest = {
  model: string;
  /** Frozen for the whole run: changing it mid-run would invalidate earlier thinking blocks and the prompt cache. */
  system: string;
  messages: LlmMessage[];
  /** Same set and order on every step of a run. */
  tools: LlmTool[];
  maxTokens?: number;
  effort?: Effort;
  signal?: AbortSignal;
};

export type LlmResponse = {
  id: string;
  /** The model that actually served the turn (differs from the request after a refusal fallback). */
  model: string;
  content: LlmContentBlock[];
  stopReason: string | null;
  usage: Usage;
  stopDetails?: { category?: string | null; explanation?: string | null } | null;
};

export interface LlmProvider {
  readonly id: string;
  chat(req: LlmRequest): Promise<LlmResponse>;
  /** One-shot structured extraction validated against a zod schema. */
  extract<T>(req: { model?: string; system: string; content: Anthropic.Beta.BetaContentBlockParam[]; schema: z.ZodType<T>; maxTokens?: number; signal?: AbortSignal }): Promise<{ data: T; usage: Usage; model: string }>;
}

function usageOf(u: Anthropic.Beta.BetaUsage | undefined): Usage {
  return {
    inputTokens: u?.input_tokens ?? 0,
    outputTokens: u?.output_tokens ?? 0,
    cacheReadTokens: u?.cache_read_input_tokens ?? 0,
    cacheWriteTokens: u?.cache_creation_input_tokens ?? 0,
    webSearchRequests: u?.server_tool_use?.web_search_requests ?? 0,
  };
}

/** Map SDK errors to platform errors: 429 reschedules, 5xx/network retry, 4xx fails. */
function mapError(err: unknown): never {
  if (err instanceof Anthropic.RateLimitError) {
    const ra = Number(err.headers?.get?.('retry-after'));
    throw new RateLimitedError(Number.isFinite(ra) && ra > 0 ? ra * 1000 : 30_000, 'Anthropic rate limit');
  }
  if (err instanceof Anthropic.APIConnectionError) throw new ProviderError('anthropic', err.message, { transient: true });
  if (err instanceof Anthropic.InternalServerError) throw new ProviderError('anthropic', err.message, { status: err.status, transient: true });
  if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
    throw new ProviderError('anthropic', 'The Anthropic API key was rejected. Update it under Settings → Integrations.', { status: err.status, transient: false });
  }
  if (err instanceof Anthropic.APIError) throw new ProviderError('anthropic', err.message, { status: err.status, transient: false });
  throw err;
}

export class AnthropicProvider implements LlmProvider {
  readonly id = 'anthropic';
  private readonly client: Anthropic;

  /**
   * `workspaceId` is for personal or service-account keys that aren't scoped to a
   * workspace: the API then needs the `anthropic-workspace-id` header on every request.
   */
  constructor(apiKey: string, opts: { workspaceId?: string | null } = {}) {
    this.client = new Anthropic({ apiKey, maxRetries: 2, defaultHeaders: opts.workspaceId ? { 'anthropic-workspace-id': opts.workspaceId } : undefined });
  }

  /** Request fields that depend on what the model supports. */
  private modelParams(model: string, effort: Effort | undefined) {
    const info = modelInfo(model);
    const params: Record<string, unknown> = {};
    const betas: string[] = [];
    if (info.adaptive) {
      // Thinking blocks are replayed unchanged; drop_block keeps a run going if a
      // block ever fails the prefix check (e.g. the agent's model was changed mid-run).
      params.thinking = { type: 'adaptive', display: 'summarized', block_binding: { prefix_mismatch_behavior: 'drop_block' } };
      params.output_config = { effort: effort ?? 'high' };
      betas.push('thinking-binding-controls-2026-08-01');
    }
    if (info.fallbacks) {
      // If a safety classifier declines a turn, the API re-runs it on a fallback model.
      params.fallbacks = 'default';
      betas.push('server-side-fallback-2026-07-01');
    }
    return { params, betas };
  }

  async chat(req: LlmRequest): Promise<LlmResponse> {
    const model = req.model || DEFAULT_MODEL;
    const { params, betas } = this.modelParams(model, req.effort);
    try {
      const res = await this.client.beta.messages.create(
        {
          model,
          max_tokens: req.maxTokens ?? 16_000,
          system: req.system,
          messages: req.messages,
          tools: req.tools.length ? req.tools : undefined,
          cache_control: { type: 'ephemeral' },
          betas,
          ...params,
        } as unknown as Anthropic.Beta.MessageCreateParamsNonStreaming,
        { signal: req.signal },
      );
      return {
        id: res.id,
        model: res.model,
        content: res.content,
        stopReason: res.stop_reason,
        usage: usageOf(res.usage),
        stopDetails: (res as unknown as { stop_details?: LlmResponse['stopDetails'] }).stop_details ?? null,
      };
    } catch (err) {
      mapError(err);
    }
  }

  async extract<T>(req: { model?: string; system: string; content: Anthropic.Beta.BetaContentBlockParam[]; schema: z.ZodType<T>; maxTokens?: number; signal?: AbortSignal }) {
    const model = req.model ?? DEFAULT_MODEL;
    const info = modelInfo(model);
    try {
      const res = await this.client.messages.parse(
        {
          model,
          max_tokens: req.maxTokens ?? 16_000,
          system: req.system,
          messages: [{ role: 'user', content: req.content as Anthropic.ContentBlockParam[] }],
          output_config: { format: zodOutputFormat(req.schema as never), ...(info.adaptive ? { effort: 'medium' } : {}) },
        } as never,
        { signal: req.signal },
      );
      const r = res as unknown as { parsed_output: T | null; usage: Anthropic.Beta.BetaUsage; stop_reason: string; model: string };
      if (r.stop_reason === 'refusal') throw new ProviderError('anthropic', 'The model declined to process this document', { transient: false });
      if (r.parsed_output == null) throw new ProviderError('anthropic', 'The model did not return valid structured output', { transient: false });
      return { data: r.parsed_output, usage: usageOf(r.usage), model: r.model };
    } catch (err) {
      if (err instanceof ProviderError) throw err;
      mapError(err);
    }
  }
}

/** Text of a response, ignoring thinking and tool blocks. */
export function responseText(content: LlmContentBlock[]): string {
  return content
    .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim();
}

export function toolUses(content: LlmContentBlock[]): Anthropic.Beta.BetaToolUseBlock[] {
  return content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === 'tool_use');
}

/** Summarised reasoning, when the model returned it, for the live run view. */
export function thinkingSummary(content: LlmContentBlock[]): string {
  return content
    .map((b) => (b.type === 'thinking' ? (b as Anthropic.Beta.BetaThinkingBlock).thinking : ''))
    .filter(Boolean)
    .join('\n')
    .trim();
}

/** Recommended summarisation instruction for client-side "simple compaction". */
export const COMPACTION_PROMPT =
  'Summarize the transcript inside <summary></summary> tags. Include relevant information in the summary such that this conversation will be continued by a new context window without needing to redo work or be reprovided with relevant constraints or context. Be sure to preserve: (1) any difficulties or problems that came up, and how they were handled or resolved; (2) any possibilities, options, or approaches that were raised, tried, or set aside, and why; (3) anything that was asked for, decided, agreed, ruled out, or established as a preference, constraint, or boundary - stated exactly; (4) exactly where things stand now - what has been covered, settled, or completed so far; (5) anything still open, unresolved, promised, or expected to happen next; (6) specific details that would be hard to reconstruct - names, numbers, dates, exact wording, links or references - kept exactly. Be complete on these even at the cost of length; keep everything else concise. Weight the two voices differently: keep what the user said, asked for, shared, or established carefully and close to their own words; your own explanations and reasoning can be condensed much further, to what they concluded or produced - as long as nothing in the six items above is dropped. Do not call any tools while writing this summary; respond with text only.';
