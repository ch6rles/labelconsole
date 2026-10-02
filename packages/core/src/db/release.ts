import postgres from 'postgres';
import { runMigrations } from './migrate';
import { setupDatabase } from './setup';
import { applyDerivedDatabaseUrls } from './urls';

/**
 * The release steps: create roles, database and extensions when an admin URL
 * is available (DATABASE_SUPERUSER_URL), then apply migrations and RLS
 * policies. Both are idempotent. Used by `dist/setup.js` and `dist/migrate.js`,
 * and at start by the worker and the web app on hosts with no separate release
 * step (see releaseOnStart).
 *
 * With an admin URL, the steps run under a Postgres advisory lock on the admin
 * database, so the web app and the worker starting at the same moment take
 * turns instead of racing to create the same roles.
 */
export async function runRelease(opts: { setup: boolean; migrate: boolean; log: (m: string) => void }) {
  applyDerivedDatabaseUrls();
  const { DATABASE_SUPERUSER_URL: superuserUrl, DATABASE_URL: appUrl, DATABASE_SYSTEM_URL: systemUrl } = process.env;
  if (!appUrl || !systemUrl) throw new Error('Set DATABASE_URL and DATABASE_SYSTEM_URL, or DATABASE_SUPERUSER_URL together with SIGNING_SECRET');
  if (opts.setup && !superuserUrl) throw new Error('DATABASE_SUPERUSER_URL must be set to create the database and its roles');
  const steps = async () => {
    if (opts.setup) await setupDatabase({ superuserUrl: superuserUrl!, appUrl, systemUrl, log: (m) => opts.log(`[setup] ${m}`) });
    if (opts.migrate) await runMigrations(systemUrl, { appRole: process.env.DB_APP_ROLE ?? decodeURIComponent(new URL(appUrl).username), log: (m) => opts.log(`[migrate] ${m}`) });
  };
  if (!superuserUrl) return steps();
  const lock = postgres(superuserUrl, { max: 1, onnotice: () => {} });
  try {
    await lock`select pg_advisory_lock(hashtext('labelconsole:release'))`;
    await steps();
  } finally {
    await lock`select pg_advisory_unlock(hashtext('labelconsole:release'))`.catch(() => undefined);
    await lock.end({ timeout: 5 });
  }
}

/**
 * Whether this process should run the release steps when it starts: always
 * when the database URLs are derived from an admin URL (Railway-style hosting,
 * where nothing else creates the roles), or when LC_RELEASE_ON_START=1.
 */
export function releaseOnStart() {
  applyDerivedDatabaseUrls();
  return process.env.LC_DATABASE_URLS_DERIVED === '1' || process.env.LC_RELEASE_ON_START === '1';
}
