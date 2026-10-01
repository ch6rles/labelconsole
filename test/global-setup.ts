import 'dotenv/config';
import { Redis } from 'ioredis';
import { runMigrations } from '../packages/core/src/db/migrate';
import { setupDatabase } from '../packages/core/src/db/setup';
import { TEST_ENV } from './test-env';

export default async function setup() {
  await setupDatabase({
    superuserUrl: process.env.DATABASE_SUPERUSER_URL ?? 'postgres://postgres:postgres@127.0.0.1:5432/postgres',
    appUrl: TEST_ENV.DATABASE_URL,
    systemUrl: TEST_ENV.DATABASE_SYSTEM_URL,
    reset: true,
  });
  await runMigrations(TEST_ENV.DATABASE_SYSTEM_URL, { appRole: 'labelconsole_app' });
  const r = new Redis(TEST_ENV.REDIS_URL);
  await r.flushdb();
  await r.quit();
}
