import { runRelease } from './release';

/**
 * One-time database bootstrap: roles (owner + restricted app role), the
 * database and the extensions, using DATABASE_SUPERUSER_URL. Needed for a
 * fresh Postgres (docker compose, a new server). With only
 * DATABASE_SUPERUSER_URL and SIGNING_SECRET set, the role URLs are derived
 * (see packages/core/src/db/urls.ts). Idempotent.
 *   node dist/setup.js
 */
try {
  await runRelease({ setup: true, migrate: false, log: console.log });
  console.log('[setup] done');
} catch (err) {
  console.error(`[setup] ${(err as Error).message}`);
  process.exit(1);
}
