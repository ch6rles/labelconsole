import { acceptInvitation, createSession } from '@labelconsole/core/auth';
import { AcceptInviteSchema } from '@labelconsole/core/schemas';
import { handler, json } from '@/server/http';
import { sessionCookie, sessionFromRequest } from '@/server/session';

export async function POST(req: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return handler({ name: 'invite', schema: AcceptInviteSchema, limit: { capacity: 8, refillPerSec: 0.1 } }, async (body) => {
    const existing = await sessionFromRequest(req);
    const { userId, orgId } = await acceptInvitation(token, { ...body, existingUserId: existing?.user.id });
    const { token: sessionToken, expiresAt } = await createSession(userId, orgId);
    return json({ ok: true }, 200, { 'set-cookie': sessionCookie(sessionToken, expiresAt) });
  })(req);
}
