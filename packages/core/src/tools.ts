import { z } from 'zod';
import type { ServiceContext } from './context';
import type { Logger } from './logger';
import type { CredentialHandle } from './vault';

/**
 * Agent tools. Modules register tools that call their own service layer, so an
 * agent can do exactly what a staff member can do through the UI, under the
 * same permission checks.
 */
export type RiskLevel = 'read' | 'write' | 'external' | 'destructive' | 'spend';
export const RISK_LEVELS: RiskLevel[] = ['read', 'write', 'external', 'destructive', 'spend'];

export interface ToolContext {
  orgId: string;
  agentId: string;
  runId: string;
  stepId: string;
  /** Stable per tool call; reuse it for any external side effect. */
  idempotencyKey: string;
  signal: AbortSignal;
  log: Logger;
  /** Short transaction scoped to the org, acting as the agent principal. */
  withOrg<T>(fn: (ctx: ServiceContext) => Promise<T>): Promise<T>;
  /** A handle to a stored credential. Tools never see the secret unless they call `use`. */
  credential(provider: string): Promise<CredentialHandle | null>;
  /** Start a child run for another agent (only the delegate tool uses this). */
  delegate?(input: { agentId: string; task: string }): Promise<{ childRunId: string }>;
}

export interface ToolDefinition<I extends z.ZodType = z.ZodType, O = unknown> {
  name: string;
  module: string;
  description: string;
  input: I;
  permission: string;
  risk: RiskLevel;
  timeoutMs?: number;
  rateLimit?: { capacity: number; refillPerSec: number };
  /** True when repeating the call has no extra effect, so it can be retried freely. */
  idempotent?: boolean;
  /** Human-readable summary of what the call will do, shown in the approvals inbox. */
  preview?(input: z.infer<I>): string;
  execute(ctx: ToolContext, input: z.infer<I>): Promise<O>;
}

export function defineTool<I extends z.ZodType, O>(def: ToolDefinition<I, O>): ToolDefinition {
  return def as unknown as ToolDefinition;
}

/** JSON schema for the LLM, derived from the same zod schema used for validation. */
export function toolJsonSchema(tool: ToolDefinition): Record<string, unknown> {
  const schema = z.toJSONSchema(tool.input, { target: 'draft-7', unrepresentable: 'any' }) as Record<string, unknown>;
  delete schema.$schema;
  if (schema.type !== 'object') return { type: 'object', properties: {}, additionalProperties: false };
  return schema;
}

/** Return value helper: keep tool results compact so prompts stay small. */
export function compact<T>(value: T, maxChars = 12_000): T | { truncated: true; preview: string } {
  const text = JSON.stringify(value);
  if (text.length <= maxChars) return value;
  return { truncated: true, preview: text.slice(0, maxChars) };
}
