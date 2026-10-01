import { SESSION_COOKIE, switchOrg } from '@labelconsole/core/auth';
import { UnauthorizedError } from '@labelconsole/core/errors';
import { SwitchOrgSchema } from '@labelconsole/core/schemas';
import { cookies } from 'next/headers';
import { handler, json } from '@/server/http';

export const POST = handler({ name: 'switch-org', schema: SwitchOrgSchema, limit: { capacity: 30, refillPerSec: 1 } }, async (body) => {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) throw new UnauthorizedError();
  await switchOrg(token, body.orgId);
  return json({ ok: true });
});
