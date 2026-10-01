import { createOrgForUser } from '@labelconsole/core/auth';
import { UnauthorizedError } from '@labelconsole/core/errors';
import { CreateOrgSchema } from '@labelconsole/core/schemas';
import { handler, json } from '@/server/http';
import { sessionFromRequest } from '@/server/session';

export const POST = handler({ name: 'create-org', schema: CreateOrgSchema, limit: { capacity: 5, refillPerSec: 0.05 } }, async (body, req) => {
  const s = await sessionFromRequest(req);
  if (!s) throw new UnauthorizedError();
  const org = await createOrgForUser(s.user.id, body.name);
  return json({ id: org.id, name: org.name }, 201);
});
