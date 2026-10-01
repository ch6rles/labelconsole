import { timingSafeEqual } from 'node:crypto';
import { systemDb } from '@labelconsole/core/db/client';
import { env } from '@labelconsole/core/env';
import { logger } from '@labelconsole/core/logger';
import { coreMetrics, renderPrometheus, type Metric } from '@labelconsole/core/metrics';
import { modules } from '@labelconsole/core/modules';
import '@/server/modules';

export const dynamic = 'force-dynamic';

/**
 * Prometheus scrape endpoint for operators. Off unless METRICS_TOKEN is set;
 * then it needs `Authorization: Bearer <token>`. Aggregates only: no label,
 * user or catalogue data is exposed.
 */
export async function GET(req: Request) {
  const token = env().METRICS_TOKEN;
  if (!token) return new Response('Not found', { status: 404 });
  const given = Buffer.from(req.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? '');
  const expected = Buffer.from(token);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return new Response('Unauthorized', { status: 401, headers: { 'www-authenticate': 'Bearer' } });

  const metrics: Metric[] = await coreMetrics();
  for (const m of modules()) {
    if (!m.metrics) continue;
    try {
      metrics.push(...(await m.metrics(systemDb())));
    } catch (err) {
      // One module's query failing shouldn't blank the whole scrape.
      logger.warn({ err, module: m.manifest.id }, 'module metrics failed');
      metrics.push({ name: 'lc_metrics_errors', help: 'Modules whose metrics failed in this scrape.', type: 'gauge', samples: [{ labels: { module: m.manifest.id }, value: 1 }] });
    }
  }
  return new Response(renderPrometheus(metrics), { headers: { 'content-type': 'text/plain; version=0.0.4; charset=utf-8', 'cache-control': 'no-store' } });
}
