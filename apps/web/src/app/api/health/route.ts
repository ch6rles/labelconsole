import { sql } from 'drizzle-orm';
import { systemDb } from '@labelconsole/core/db/client';
import { outboxLag, workerHeartbeats } from '@labelconsole/core/metrics';
import { redis } from '@labelconsole/core/redis';

export const dynamic = 'force-dynamic';

/** Events older than this waiting in the outbox mean listeners have stopped keeping up. */
const OUTBOX_LAG_LIMIT_SEC = 300;

/**
 * Liveness for the web process: Postgres and Redis. `?deep=1` also checks the
 * background side (a live worker heartbeat and outbox lag) for uptime
 * monitors; keep load-balancer probes on the shallow check so a worker outage
 * never takes the web app out of rotation.
 */
export async function GET(req: Request) {
  const deep = new URL(req.url).searchParams.get('deep') === '1';
  const checks: Record<string, string> = {};
  const details: Record<string, unknown> = {};
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
  if (deep && checks.postgres === 'ok' && checks.redis === 'ok') {
    const [beats, lag] = await Promise.all([workerHeartbeats(), outboxLag()]);
    checks.worker = beats.length ? 'ok' : 'no worker heartbeat in the last 45s';
    checks.outbox = lag.oldestSeconds <= OUTBOX_LAG_LIMIT_SEC ? 'ok' : `oldest event waiting ${Math.round(lag.oldestSeconds)}s`;
    details.workers = beats.map((b) => ({ id: b.id, active: b.active, startedAt: b.startedAt, at: b.at }));
    details.outbox = lag;
  }
  const ok = Object.values(checks).every((v) => v === 'ok');
  return Response.json({ ok, checks, ...details }, { status: ok ? 200 : 503 });
}
