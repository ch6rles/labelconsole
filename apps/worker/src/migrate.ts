import { runRelease } from './release';

/**
 * Release step: apply migrations, custom SQL and RLS policies, then exit.
 * Run it once per deploy before starting the new web and worker processes:
 *   node dist/migrate.js
 * Safe to run repeatedly.
 */
try {
  await runRelease({ setup: false, migrate: true, log: console.log });
  console.log('[migrate] done');
} catch (err) {
  console.error(`[migrate] ${(err as Error).message}`);
  process.exit(1);
}
