import { sql } from 'drizzle-orm';
import { systemDb } from '@labelconsole/core/db/client';
import { redis } from '@labelconsole/core/redis';

export const dynamic = 'force-dynamic';

export async function GET() {
  const checks: Record<string, string> = {};
  try {
    await systemDb().execute(sql`select 1`);
    checks.postgres = 'ok';
  } catch (e) {
    checks.postgres = (e as Error).message;
  }
  try {
    checks.redis = (await redis().ping()) === 'PONG' ? 'ok' : 'unexpected reply';
  } catch (e) {
    checks.redis = (e as Error).message;
  }
  const ok = Object.values(checks).every((v) => v === 'ok');
  return Response.json({ ok, checks }, { status: ok ? 200 : 503 });
}
