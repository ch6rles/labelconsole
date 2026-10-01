import { createSession, signup } from '@labelconsole/core/auth';
import { SignupSchema } from '@labelconsole/core/schemas';
import { handler, json } from '@/server/http';
import { sessionCookie } from '@/server/session';

export const POST = handler({ name: 'signup', schema: SignupSchema, limit: { capacity: 5, refillPerSec: 0.02 } }, async (body, req) => {
  const { user, org } = await signup(body);
  const { token, expiresAt } = await createSession(user.id, org.id, { ip: req.headers.get('x-forwarded-for') ?? undefined, userAgent: req.headers.get('user-agent') ?? undefined });
  return json({ ok: true, orgId: org.id }, 201, { 'set-cookie': sessionCookie(token, expiresAt) });
});
