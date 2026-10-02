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
/** The innermost error: drizzle wraps the driver's error ("Failed query: …") and keeps the real reason in `cause`. */
function rootCause(e: unknown): string {
  let err = e as { message?: string; code?: string; cause?: unknown };
  while (err?.cause) err = err.cause as typeof err;
  return [err?.code, err?.message].filter(Boolean).join(': ') || String(e);
}

/** Which database connection failed, without the password, so a setup mistake can be told apart from an outage. */
function connectionInfo() {
  try {
    const u = new URL(process.env.DATABASE_SYSTEM_URL ?? '');
    return { user: decodeURIComponent(u.username), host: u.hostname, database: u.pathname.slice(1), derivedFromAdminUrl: process.env.LC_DATABASE_URLS_DERIVED === '1' };
  } catch {
    return { user: null, host: null, database: null };
  }
}

export async function GET(req: Request) {
  const deep = new URL(req.url).searchParams.get('deep') === '1';
  const checks: Record<string, string> = {};
  const details: Record<string, unknown> = {};
  try {
    await systemDb().execute(sql`select 1`);
    checks.postgres = 'ok';
  } catch (e) {
    checks.postgres = rootCause(e);
    details.database = connectionInfo();
  }
  try {
    checks.redis = (await redis().ping()) === 'PONG' ? 'ok' : 'unexpected reply';
  } catch (e) {
    checks.redis = rootCause(e);
  }
  // Heartbeats live in Redis, so the worker can be checked even while Postgres is down.
  if (deep && checks.redis === 'ok') {
    const beats = await workerHeartbeats();
    checks.worker = beats.length ? 'ok' : 'no worker heartbeat in the last 45s';
    details.workers = beats.map((b) => ({ id: b.id, active: b.active, startedAt: b.startedAt, at: b.at }));
  }
  if (deep && checks.postgres === 'ok' && checks.redis === 'ok') {
    const lag = await outboxLag();
    checks.outbox = lag.oldestSeconds <= OUTBOX_LAG_LIMIT_SEC ? 'ok' : `oldest event waiting ${Math.round(lag.oldestSeconds)}s`;
    details.outbox = lag;
  }
  const ok = Object.values(checks).every((v) => v === 'ok');
  // Which commit is live, so a deploy can be confirmed from outside (Railway sets this for GitHub deploys).
  const version = process.env.RAILWAY_GIT_COMMIT_SHA?.slice(0, 7) ?? null;
  return Response.json({ ok, version, checks, ...details }, { status: ok ? 200 : 503 });
}
