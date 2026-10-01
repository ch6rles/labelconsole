import 'dotenv/config';
import { setupDatabase } from '../packages/core/src/db/setup';

const reset = process.argv.includes('--reset');
const superuserUrl = process.env.DATABASE_SUPERUSER_URL ?? 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

await setupDatabase({
  superuserUrl,
  appUrl: process.env.DATABASE_URL!,
  systemUrl: process.env.DATABASE_SYSTEM_URL!,
  reset,
  log: (m) => console.log(`[db:setup] ${m}`),
});
console.log('[db:setup] done');
