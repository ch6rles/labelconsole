/**
 * Runs once when the web server starts. On hosts where the database URLs are
 * derived from one admin URL (Railway), make sure the database, its roles and
 * the schema exist before the first request, rather than relying on the worker
 * to have done it. The worker does the same; an advisory lock makes them take
 * turns, and every step is idempotent.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  const { releaseOnStart, runRelease } = await import('@labelconsole/core/db/release');
  if (!releaseOnStart()) return;
  try {
    await runRelease({ setup: Boolean(process.env.DATABASE_SUPERUSER_URL), migrate: true, log: (m) => console.log(`[release] ${m}`) });
  } catch (err) {
    // Keep serving: /api/health reports the database problem in detail.
    console.error(`[release] failed: ${(err as Error).message}`);
  }
}
