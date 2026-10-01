import { eq } from 'drizzle-orm';
import { withSystemOrg } from '@labelconsole/core/context';
import { systemDb } from '@labelconsole/core/db/client';
import { organizations } from '@labelconsole/core/db/schema';
import { RateLimitedError, ValidationError } from '@labelconsole/core/errors';
import { enabledModuleIds } from '@labelconsole/core/modules';
import { tryAcquire } from '@labelconsole/core/ratelimit';
import { errorResponse, json } from '@labelconsole/core/router';
import { triggers } from '@labelconsole/agents/schema';
import { hashToken, startRun } from '@labelconsole/agents/service';
import '@/server/modules';

export const dynamic = 'force-dynamic';

const MAX_BODY = 64 * 1024;

/**
 * Inbound webhook that starts an agent run. The secret token in the URL is
 * the credential (only its hash is stored). Cross-origin by design, so no
 * session or same-origin check; rate limited per trigger.
 */
export async function POST(req: Request, { params }: { params: Promise<{ token: string }> }) {
  try {
    const { token } = await params;
    if (!/^[\w-]{20,64}$/.test(token)) return json({ error: { code: 'not_found', message: 'Unknown webhook' } }, 404);
    const [trigger] = await systemDb().select().from(triggers).where(eq(triggers.tokenHash, hashToken(token)));
    if (!trigger || !trigger.enabled || trigger.config.kind !== 'webhook') return json({ error: { code: 'not_found', message: 'Unknown webhook' } }, 404);
    const rl = await tryAcquire(`agent-webhook:${trigger.id}`, { capacity: 10, refillPerSec: 1 / 6 });
    if (!rl.allowed) throw new RateLimitedError(rl.waitMs, 'Too many webhook calls for this agent. Slow down.');
    const [org] = await systemDb().select({ id: organizations.id, plan: organizations.plan }).from(organizations).where(eq(organizations.id, trigger.orgId));
    if (!org || !(await enabledModuleIds(systemDb(), org)).has('agents')) return json({ error: { code: 'not_found', message: 'Unknown webhook' } }, 404);
    const raw = await req.text();
    if (raw.length > MAX_BODY) throw new ValidationError('Payload too large (64 KB max)');
    let body: unknown = raw;
    if (raw && req.headers.get('content-type')?.includes('json')) {
      try {
        body = JSON.parse(raw);
      } catch {
        throw new ValidationError('Body is not valid JSON');
      }
    }
    const run = await withSystemOrg(
      trigger.orgId,
      async (ctx) => {
        await ctx.tx.update(triggers).set({ lastFiredAt: new Date() }).where(eq(triggers.id, trigger.id));
        return startRun(ctx, { agentId: trigger.agentId, triggerKind: 'webhook', triggerId: trigger.id, task: trigger.config.kind === 'webhook' ? (trigger.config.task ?? 'An inbound webhook arrived. Handle it.') : null, input: { webhook: body } });
      },
      'agent webhook',
    );
    return json({ ok: true, runId: run.id }, 202);
  } catch (err) {
    return errorResponse(err);
  }
}
