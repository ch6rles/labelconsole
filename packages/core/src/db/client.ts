import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { env } from '../env';

export type Database = PostgresJsDatabase<Record<string, never>>;
export type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];
export type DbLike = Database | Tx;

type Pool = { sql: postgres.Sql; db: Database };

let app: Pool | undefined;
let system: Pool | undefined;

function makePool(url: string, max: number): Pool {
  const sql = postgres(url, {
    max,
    idle_timeout: 30,
    connect_timeout: 10,
    prepare: true,
    onnotice: () => {},
    // Return bigint/numeric as strings; services convert explicitly.
    types: {},
  });
  return { sql, db: drizzle(sql) };
}

/**
 * Restricted role. Every tenant query runs here inside `withOrg`, so Postgres
 * row-level security enforces isolation even if a handler has a bug.
 */
export function appDb(): Database {
  if (!app) app = makePool(env().DATABASE_URL, Number(process.env.DB_POOL_MAX ?? 10));
  return app.db;
}

/**
 * Owner role: bypasses RLS. For work that is cross-tenant by nature: sign-up,
 * session lookup, webhook routing, and the scheduler jobs that fan out to each
 * label (which then do their real work inside `withSystemOrg`). Never use it in
 * services or request handlers; tenant data is read through `withOrg`.
 */
export function systemDb(): Database {
  if (!system) system = makePool(env().DATABASE_SYSTEM_URL, Number(process.env.DB_SYSTEM_POOL_MAX ?? 4));
  return system.db;
}

export function appSql(): postgres.Sql {
  appDb();
  return app!.sql;
}

export function systemSql(): postgres.Sql {
  systemDb();
  return system!.sql;
}

export async function closeDb() {
  await Promise.all([app?.sql.end({ timeout: 5 }), system?.sql.end({ timeout: 5 })]);
  app = undefined;
  system = undefined;
}
