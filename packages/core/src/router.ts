import { z } from 'zod';
import type { SessionInfo } from './auth';
import { withOrg, type ServiceContext } from './context';
import { env } from './env';
import { AppError, ForbiddenError, ModuleDisabledError, NotFoundError, RateLimitedError, UnauthorizedError, ValidationError } from './errors';
import { logger } from './logger';
import { enabledModuleIds } from './modules';
import { tryAcquire } from './ratelimit';

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export type ApiRequest<B = unknown, Q = Record<string, string>> = {
  params: Record<string, string>;
  query: Q;
  body: B;
  form?: FormData;
  request: Request;
  session: SessionInfo;
};

export type ApiRoute = {
  module: string;
  method: HttpMethod;
  /** Path under /api/v1, e.g. `/catalogue/releases/:id`. */
  path: string;
  /** Permission required; `null` means any member of the org. */
  permission: string | null;
  body?: z.ZodType;
  query?: z.ZodType;
  /** Parse multipart/form-data before the transaction opens (uploads). */
  multipart?: boolean;
  status?: number;
  handler: (ctx: ServiceContext, req: ApiRequest<any, any>) => Promise<unknown>;
};

type RouteInput<B extends z.ZodType | undefined, Q extends z.ZodType | undefined> = {
  method: HttpMethod;
  path: string;
  permission: string | null;
  body?: B;
  query?: Q;
  multipart?: boolean;
  status?: number;
  handler: (
    ctx: ServiceContext,
    req: ApiRequest<B extends z.ZodType ? z.infer<B> : undefined, Q extends z.ZodType ? z.infer<Q> : Record<string, string>>,
  ) => Promise<unknown>;
};

/** Typed route helper: body and query types flow from the zod schemas. */
export function route<B extends z.ZodType | undefined = undefined, Q extends z.ZodType | undefined = undefined>(def: RouteInput<B, Q>) {
  return def as unknown as Omit<ApiRoute, 'module'>;
}

export function defineRoutes(module: string, routes: Array<Omit<ApiRoute, 'module'>>): ApiRoute[] {
  return routes.map((r) => ({ ...r, module }));
}

type Compiled = ApiRoute & { regex: RegExp; keys: string[] };

function compile(r: ApiRoute): Compiled {
  const keys: string[] = [];
  const pattern = r.path
    .split('/')
    .map((seg) => {
      if (seg.startsWith(':')) {
        keys.push(seg.slice(1));
        return '([^/]+)';
      }
      return seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    })
    .join('/');
  return { ...r, regex: new RegExp(`^${pattern}$`), keys };
}

export function json(data: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(data, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers },
  });
}

export function errorResponse(err: unknown) {
  if (err instanceof AppError) {
    const headers: Record<string, string> = {};
    if (err instanceof RateLimitedError) headers['retry-after'] = String(Math.ceil(err.retryAfterMs / 1000));
    return json({ error: { code: err.code, message: err.message, details: err.details } }, err.status, headers);
  }
  if (err instanceof z.ZodError) {
    return json({ error: { code: 'validation_failed', message: 'Some fields are invalid', details: z.flattenError(err) } }, 422);
  }
  logger.error({ err }, 'unhandled API error');
  return json({ error: { code: 'internal', message: 'Something went wrong' } }, 500);
}

/** Reject cross-site mutations: the Origin must be the app itself. */
export function assertSameOrigin(req: Request) {
  const origin = req.headers.get('origin');
  const site = req.headers.get('sec-fetch-site');
  if (site && site !== 'same-origin' && site !== 'none') throw new ForbiddenError('Cross-site request blocked');
  if (origin) {
    const allowed = new URL(env().APP_URL).origin;
    const host = req.headers.get('x-forwarded-host') ?? req.headers.get('host');
    const sameHost = host ? new URL(origin).host === host : false;
    if (origin !== allowed && !sameHost) throw new ForbiddenError('Cross-site request blocked');
  }
}

export function clientIp(req: Request) {
  return req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? req.headers.get('x-real-ip') ?? undefined;
}

function coerceQuery(url: URL) {
  const out: Record<string, string | string[]> = {};
  for (const [k, v] of url.searchParams) {
    const prev = out[k];
    out[k] = prev === undefined ? v : Array.isArray(prev) ? [...prev, v] : [prev, v];
  }
  return out;
}

export function createRouter(routes: ApiRoute[], opts: { resolveSession: (req: Request) => Promise<SessionInfo | null> }) {
  const compiled = routes.map(compile);

  return async function handle(req: Request, segments: string[]): Promise<Response> {
    const path = '/' + segments.map(decodeURIComponent).join('/');
    const method = req.method.toUpperCase() as HttpMethod;
    try {
      const candidates = compiled.filter((r) => r.regex.test(path));
      if (candidates.length === 0) throw new NotFoundError('Endpoint');
      const r = candidates.find((c) => c.method === method);
      if (!r) return json({ error: { code: 'method_not_allowed', message: `${method} not allowed` } }, 405);

      const session = await opts.resolveSession(req);
      if (!session) throw new UnauthorizedError();
      if (method !== 'GET') assertSameOrigin(req);

      const rl = await tryAcquire(`api:user:${session.user.id}`, { capacity: 120, refillPerSec: 12 });
      if (!rl.allowed) throw new RateLimitedError(rl.waitMs);

      if (r.permission && !session.permissions.has(r.permission)) throw new ForbiddenError(`Missing permission ${r.permission}`, { permission: r.permission });

      const m = r.regex.exec(path)!;
      const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
      const url = new URL(req.url);
      const query = r.query ? r.query.parse(coerceQuery(url)) : Object.fromEntries(url.searchParams);

      let body: unknown = undefined;
      let form: FormData | undefined;
      if (r.multipart) {
        form = await req.formData();
      } else if (method !== 'GET' && method !== 'DELETE') {
        const text = await req.text();
        const raw = text ? JSON.parse(text) : {};
        body = r.body ? r.body.parse(raw) : raw;
      }

      const result = await withOrg(
        { orgId: session.org.id, actor: { type: 'user', id: session.user.id, name: session.user.name }, permissions: session.permissions, artistScope: session.membership.artistScope, ip: clientIp(req) },
        async (ctx) => {
          const enabled = await enabledModuleIds(ctx.tx, session.org);
          if (!enabled.has(r.module)) throw new ModuleDisabledError(r.module);
          return r.handler(ctx, { params, query, body, form, request: req, session });
        },
      );
      if (result instanceof Response) return result;
      return json(result ?? { ok: true }, r.status ?? (method === 'POST' ? 201 : 200));
    } catch (err) {
      if (err instanceof SyntaxError) return errorResponse(new ValidationError('Request body is not valid JSON'));
      return errorResponse(err);
    }
  };
}
