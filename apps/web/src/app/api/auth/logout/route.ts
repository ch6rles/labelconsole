import { SESSION_COOKIE, revokeSession } from '@labelconsole/core/auth';
import { cookies } from 'next/headers';
import { handler, json } from '@/server/http';
import { clearedSessionCookie } from '@/server/session';

export const POST = handler({ name: 'logout', limit: { capacity: 30, refillPerSec: 1 } }, async () => {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (token) await revokeSession(token);
  return json({ ok: true }, 200, { 'set-cookie': clearedSessionCookie() });
});
