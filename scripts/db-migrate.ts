import 'dotenv/config';
import { runMigrations } from '../packages/core/src/db/migrate';

await runMigrations(process.env.DATABASE_SYSTEM_URL!, {
  appRole: process.env.DB_APP_ROLE ?? new URL(process.env.DATABASE_URL!).username,
  log: (m) => console.log(`[db:migrate] ${m}`),
});
console.log('[db:migrate] done');
