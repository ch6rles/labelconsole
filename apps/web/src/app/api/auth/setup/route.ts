import { createSession, setupLabel } from '@labelconsole/core/auth';
import { SetupSchema } from '@labelconsole/core/schemas';
import { handler, json } from '@/server/http';
import { sessionCookie } from '@/server/session';

/** First-run setup of the installation's one label; refused once it exists. There is no public sign-up. */
export const POST = handler({ name: 'setup', schema: SetupSchema, limit: { capacity: 5, refillPerSec: 0.02 } }, async (body, req) => {
  const { user, org } = await setupLabel(body);
  const { token, expiresAt } = await createSession(user.id, org.id, { ip: req.headers.get('x-forwarded-for') ?? undefined, userAgent: req.headers.get('user-agent') ?? undefined });
  return json({ ok: true, orgId: org.id }, 201, { 'set-cookie': sessionCookie(token, expiresAt) });
});
