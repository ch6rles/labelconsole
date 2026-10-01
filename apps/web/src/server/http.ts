import 'server-only';
import { ZodError, type z } from 'zod';
import { RateLimitedError } from '@labelconsole/core/errors';
import { tryAcquire } from '@labelconsole/core/ratelimit';
import { assertSameOrigin, clientIp, errorResponse, json } from '@labelconsole/core/router';

/** Wrap an auth/public route: same-origin check, IP rate limit, zod body parse, error mapping. */
export function handler<S extends z.ZodType>(opts: { schema?: S; limit?: { capacity: number; refillPerSec: number }; name: string }, fn: (body: z.infer<S>, req: Request) => Promise<Response>) {
  return async (req: Request) => {
    try {
      assertSameOrigin(req);
      const ip = clientIp(req) ?? 'unknown';
      const rl = await tryAcquire(`${opts.name}:${ip}`, opts.limit ?? { capacity: 10, refillPerSec: 0.2 });
      if (!rl.allowed) throw new RateLimitedError(rl.waitMs, 'Too many attempts. Try again shortly.');
      const raw = req.headers.get('content-type')?.includes('json') ? await req.json().catch(() => ({})) : {};
      const body = opts.schema ? opts.schema.parse(raw) : raw;
      return await fn(body, req);
    } catch (err) {
      if (err instanceof ZodError) return errorResponse(err);
      return errorResponse(err);
    }
  };
}

export { json };
