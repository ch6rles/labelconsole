import 'server-only';
import { cookies, headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { cache } from 'react';
import { SESSION_COOKIE, validateSession, type SessionInfo } from '@labelconsole/core/auth';
import { withOrg, type ServiceContext } from '@labelconsole/core/context';
import { enabledModuleIds } from '@labelconsole/core/modules';
import './modules';

/** Session for the current request (memoised per render). */
export const getSession = cache(async (): Promise<SessionInfo | null> => {
  const jar = await cookies();
  return validateSession(jar.get(SESSION_COOKIE)?.value);
});

export async function requireSession(): Promise<SessionInfo> {
  const s = await getSession();
  if (!s) {
    const h = await headers();
    const next = h.get('x-lc-path') ?? '/';
    redirect(`/login?next=${encodeURIComponent(next)}`);
  }
  return s;
}

/** Run service code as the signed-in user inside an RLS-scoped transaction. */
export function runAs(session: SessionInfo) {
  return <T,>(fn: (ctx: ServiceContext) => Promise<T>) =>
    withOrg(
      { orgId: session.org.id, actor: { type: 'user', id: session.user.id, name: session.user.name }, permissions: session.permissions, artistScope: session.membership.artistScope },
      fn,
    );
}

export const getEnabledModules = cache(async (session: SessionInfo) => runAs(session)((ctx) => enabledModuleIds(ctx.tx, session.org)));

/** Session resolver for API route handlers (cookie on the raw Request). */
export async function sessionFromRequest(req: Request) {
  const cookie = req.headers.get('cookie') ?? '';
  const token = cookie
    .split(';')
    .map((c) => c.trim())
    .find((c) => c.startsWith(`${SESSION_COOKIE}=`))
    ?.slice(SESSION_COOKIE.length + 1);
  return validateSession(token ? decodeURIComponent(token) : null);
}

export function sessionCookie(token: string, expiresAt: Date) {
  const secure = process.env.NODE_ENV === 'production' || (process.env.APP_URL ?? '').startsWith('https://');
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Expires=${expiresAt.toUTCString()}${secure ? '; Secure' : ''}`;
}

export function clearedSessionCookie() {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}
