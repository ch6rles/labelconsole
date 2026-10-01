import { createSession, login } from '@labelconsole/core/auth';
import { LoginSchema } from '@labelconsole/core/schemas';
import { handler, json } from '@/server/http';
import { sessionCookie } from '@/server/session';

export const POST = handler({ name: 'login', schema: LoginSchema, limit: { capacity: 8, refillPerSec: 0.1 } }, async (body, req) => {
  const user = await login(body.email, body.password);
  const { token, expiresAt } = await createSession(user.id, null, { ip: req.headers.get('x-forwarded-for') ?? undefined, userAgent: req.headers.get('user-agent') ?? undefined });
  return json({ ok: true }, 200, { 'set-cookie': sessionCookie(token, expiresAt) });
});
