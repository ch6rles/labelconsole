import { eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { memberships, users } from '@labelconsole/core/db/schema';
import { ValidationError } from '@labelconsole/core/errors';
import { defineTool } from '@labelconsole/core/tools';
import { notify } from '../service';

export const tools = [
  defineTool({
    name: 'inbox_notify_user',
    module: 'inbox',
    description: 'Send an in-app notification to a member of the label (by email), or to the person who owns this agent when no email is given. Use it to report findings that need a human to look at them.',
    input: z.object({
      email: z.email().optional().describe('Member email. Omit to notify the agent owner.'),
      title: z.string().min(3).max(140),
      body: z.string().max(2000).optional(),
      link: z.string().max(300).optional().describe('Relative console path, e.g. /catalog/releases/<id>'),
    }),
    permission: 'inbox:read',
    risk: 'write',
    idempotent: true,
    preview: (i) => `Notify ${i.email ?? 'agent owner'}: ${i.title}`,
    execute: (t, input) =>
      t.withOrg(async (ctx) => {
        let userId: string | null = null;
        if (input.email) {
          const [u] = await ctx.tx
            .select({ id: users.id })
            .from(users)
            .innerJoin(memberships, eq(memberships.userId, users.id))
            .where(sql`lower(${users.email}) = ${input.email.toLowerCase()} and ${memberships.status} = 'active'`);
          if (!u) throw new ValidationError(`No active member with email ${input.email}`);
          userId = u.id;
        } else if (ctx.actor.type === 'agent') {
          userId = ctx.actor.ownerUserId;
        }
        if (!userId) throw new ValidationError('No recipient');
        const href = input.link?.startsWith('/') ? input.link : null;
        await notify(ctx, { userIds: [userId], kind: 'agent', title: input.title, body: input.body, href, dedupeKey: t.idempotencyKey });
        return { notified: true };
      }),
  }),
  defineTool({
    name: 'inbox_request_approval',
    module: 'inbox',
    description:
      'Ask a person to sign off on a decision before you continue (for example a plan, a budget, or a judgement call no other tool covers). The run pauses until someone approves or rejects; the result tells you which, with any note they left.',
    input: z.object({ question: z.string().min(5).max(500), details: z.string().max(4000).optional() }),
    permission: 'inbox:read',
    risk: 'write',
    requiresApproval: true,
    preview: (i) => i.question,
    execute: async (_t, input) => ({ approved: true, question: input.question }),
  }),
];
