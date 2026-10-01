import { setupDatabase } from '@labelconsole/core/db/setup';

/**
 * One-time database bootstrap: roles (owner + restricted app role), the
 * database and the extensions, using DATABASE_SUPERUSER_URL. Needed for a
 * fresh Postgres (docker compose, a new server). On managed Postgres you can
 * run it once with an admin URL, or do the same steps by hand. Idempotent.
 *   node dist/setup.js
 */
const { DATABASE_SUPERUSER_URL, DATABASE_URL, DATABASE_SYSTEM_URL } = process.env;
if (!DATABASE_SUPERUSER_URL || !DATABASE_URL || !DATABASE_SYSTEM_URL) {
  console.error('[setup] DATABASE_SUPERUSER_URL, DATABASE_URL and DATABASE_SYSTEM_URL must be set');
  process.exit(1);
}
await setupDatabase({ superuserUrl: DATABASE_SUPERUSER_URL, appUrl: DATABASE_URL, systemUrl: DATABASE_SYSTEM_URL, log: (m) => console.log(`[setup] ${m}`) });
console.log('[setup] done');
