import { sql } from 'drizzle-orm';
import type { ServiceContext } from './context';
import { usageCounters } from './db/schema';
import { env } from './env';
import { ValidationError } from './errors';
import { AnthropicProvider, type LlmProvider } from './llm';
import { getCredentialHandle, readSecret } from './vault';

/** Add to this month's usage counter (agent spend, tokens, runs) for plan and budget views. */
export async function recordUsage(ctx: ServiceContext, metric: string, value: number) {
  if (!value) return;
  const month = new Date().toISOString().slice(0, 7);
  await ctx.tx
    .insert(usageCounters)
    .values({ month, metric, value: String(value) })
    .onConflictDoUpdate({ target: [usageCounters.orgId, usageCounters.month, usageCounters.metric], set: { value: sql`${usageCounters.value} + ${String(value)}`, updatedAt: new Date() } });
}

export async function monthUsage(ctx: ServiceContext, metric: string): Promise<number> {
  const month = new Date().toISOString().slice(0, 7);
  const rows = await ctx.tx.select().from(usageCounters).where(sql`${usageCounters.month} = ${month} and ${usageCounters.metric} = ${metric}`);
  return Number(rows[0]?.value ?? 0);
}

type ProviderFactory = (ctx: ServiceContext) => Promise<LlmProvider>;
let override: ProviderFactory | null = null;

/** Tests swap in a stub provider here; production always uses Claude. */
export function setLlmProviderFactory(f: ProviderFactory | null) {
  override = f;
}

/** Whether agents can call a model at all, without decrypting anything (safe in the web process). */
export async function llmConfigured(ctx: ServiceContext): Promise<boolean> {
  if (override || env().ANTHROPIC_API_KEY) return true;
  return Boolean(await getCredentialHandle(ctx, 'anthropic'));
}

/** The label's own Anthropic key from the vault if set, else the platform key. Worker only. */
export async function llmProviderFor(ctx: ServiceContext): Promise<LlmProvider> {
  if (override) return override(ctx);
  const own = await readSecret(ctx, 'anthropic');
  const key = own?.secret.apiKey ?? env().ANTHROPIC_API_KEY;
  if (!key) throw new ValidationError('No Anthropic API key is configured. Add one under Settings → Integrations, or set ANTHROPIC_API_KEY for the platform.');
  // The workspace goes with the key it was set for: a label's own key uses the label's
  // workspace ID, the platform key uses ANTHROPIC_WORKSPACE_ID.
  const workspaceId = own ? own.secret.workspaceId : env().ANTHROPIC_WORKSPACE_ID;
  return new AnthropicProvider(key, { workspaceId });
}
