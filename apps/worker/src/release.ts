import { setupDatabase } from '@labelconsole/core/db/setup';
import { applyDerivedDatabaseUrls } from '@labelconsole/core/db/urls';
import { runMigrations } from '@labelconsole/core/db/migrate';

/**
 * The release steps: create roles, database and extensions when an admin URL
 * is available (DATABASE_SUPERUSER_URL), then apply migrations and RLS
 * policies. Both are idempotent. Used by `dist/setup.js`, `dist/migrate.js`,
 * and by the worker itself at start when LC_RELEASE_ON_START=1 (hosts with no
 * separate release step, such as Railway).
 */
export async function runRelease(opts: { setup: boolean; migrate: boolean; log: (m: string) => void }) {
  applyDerivedDatabaseUrls();
  const { DATABASE_SUPERUSER_URL: superuserUrl, DATABASE_URL: appUrl, DATABASE_SYSTEM_URL: systemUrl } = process.env;
  if (!appUrl || !systemUrl) throw new Error('Set DATABASE_URL and DATABASE_SYSTEM_URL, or DATABASE_SUPERUSER_URL together with SIGNING_SECRET');
  if (opts.setup) {
    if (!superuserUrl) throw new Error('DATABASE_SUPERUSER_URL must be set to create the database and its roles');
    await setupDatabase({ superuserUrl, appUrl, systemUrl, log: (m) => opts.log(`[setup] ${m}`) });
  }
  if (opts.migrate) {
    await runMigrations(systemUrl, { appRole: process.env.DB_APP_ROLE ?? decodeURIComponent(new URL(appUrl).username), log: (m) => opts.log(`[migrate] ${m}`) });
  }
}
