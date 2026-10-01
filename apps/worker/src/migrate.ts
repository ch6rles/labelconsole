import { runMigrations } from '@labelconsole/core/db/migrate';

/**
 * Release step: apply migrations, custom SQL and RLS policies, then exit.
 * Run it once per deploy before starting the new web and worker processes:
 *   node dist/migrate.js
 * Safe to run repeatedly.
 */
const systemUrl = process.env.DATABASE_SYSTEM_URL;
const appUrl = process.env.DATABASE_URL;
if (!systemUrl || !appUrl) {
  console.error('[migrate] DATABASE_SYSTEM_URL and DATABASE_URL must be set');
  process.exit(1);
}
await runMigrations(systemUrl, { appRole: process.env.DB_APP_ROLE ?? decodeURIComponent(new URL(appUrl).username), log: (m) => console.log(`[migrate] ${m}`) });
console.log('[migrate] done');
