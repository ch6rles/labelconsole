import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { rlsSql } from './rls';

const here = path.dirname(fileURLToPath(import.meta.url));
export const MIGRATIONS_DIR = path.resolve(here, '../../migrations');

/**
 * Apply generated migrations, then the hand-written ones (partitioning,
 * seed reference data), then RLS policies and grants. Safe to run repeatedly.
 */
export async function runMigrations(systemUrl: string, opts: { appRole?: string; log?: (msg: string) => void } = {}) {
  const log = opts.log ?? (() => {});
  const sql = postgres(systemUrl, { max: 1, onnotice: () => {} });
  try {
    await sql`create extension if not exists vector`.catch(() => log('pgvector extension not created here (requires superuser); expecting db:setup to have created it'));
    await sql`create extension if not exists pg_trgm`.catch(() => undefined);
    await migrate(drizzle(sql), { migrationsFolder: MIGRATIONS_DIR });
    log('drizzle migrations applied');

    const customDir = path.join(MIGRATIONS_DIR, 'custom');
    const files = (await readdir(customDir).catch(() => [])).filter((f) => f.endsWith('.sql')).sort();
    for (const f of files) {
      await sql.unsafe(await readFile(path.join(customDir, f), 'utf8'));
      log(`custom migration ${f} applied`);
    }

    await sql.unsafe(rlsSql(opts.appRole));
    log('row-level security policies and grants applied');
  } finally {
    await sql.end({ timeout: 5 });
  }
}
