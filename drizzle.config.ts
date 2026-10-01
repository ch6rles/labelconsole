import 'dotenv/config';
import { defineConfig } from 'drizzle-kit';

/**
 * One migration history for the whole console. Each module owns its tables in
 * `modules/<name>/schema`; drizzle-kit collects them all here.
 * `stream_snapshots` is partitioned by month and created by a hand-written
 * migration, so it is excluded from generation.
 */
export default defineConfig({
  dialect: 'postgresql',
  schema: ['./packages/core/src/db/schema.ts', './modules/*/schema/index.ts'],
  out: './packages/core/migrations',
  dbCredentials: { url: process.env.DATABASE_SYSTEM_URL ?? '' },
  tablesFilter: ['!stream_snapshots*'],
  strict: true,
  verbose: false,
});
