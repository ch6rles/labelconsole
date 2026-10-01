import postgres from 'postgres';

/**
 * Create the database, the owner role and the restricted app role, and the
 * extensions (which need a superuser). Used by `pnpm db:setup` and by the
 * integration test harness. In managed Postgres, do these steps once by hand
 * and skip this script.
 */
export async function setupDatabase(opts: { superuserUrl: string; appUrl: string; systemUrl: string; reset?: boolean; log?: (m: string) => void }) {
  const log = opts.log ?? (() => {});
  const app = new URL(opts.appUrl);
  const sys = new URL(opts.systemUrl);
  const dbName = decodeURIComponent(sys.pathname.slice(1));
  if (decodeURIComponent(app.pathname.slice(1)) !== dbName) throw new Error('DATABASE_URL and DATABASE_SYSTEM_URL must point at the same database');
  const ownerRole = decodeURIComponent(sys.username);
  const appRole = decodeURIComponent(app.username);
  const ident = (s: string) => `"${s.replace(/"/g, '""')}"`;
  const lit = (s: string) => `'${s.replace(/'/g, "''")}'`;

  const su = postgres(opts.superuserUrl, { max: 1, onnotice: () => {} });
  try {
    for (const [role, pw, bypass] of [
      [ownerRole, decodeURIComponent(sys.password), false],
      [appRole, decodeURIComponent(app.password), false],
    ] as const) {
      const [exists] = await su`select 1 from pg_roles where rolname = ${role}`;
      if (!exists) {
        await su.unsafe(`create role ${ident(role)} login password ${lit(pw)} ${bypass ? 'bypassrls' : 'nobypassrls'} nosuperuser`);
        log(`created role ${role}`);
      } else {
        await su.unsafe(`alter role ${ident(role)} login password ${lit(pw)} nosuperuser`);
      }
    }
    await su.unsafe(`alter role ${ident(appRole)} nobypassrls`);

    if (opts.reset) {
      await su.unsafe(`select pg_terminate_backend(pid) from pg_stat_activity where datname = ${lit(dbName)} and pid <> pg_backend_pid()`);
      await su.unsafe(`drop database if exists ${ident(dbName)}`);
      log(`dropped database ${dbName}`);
    }
    const [db] = await su`select 1 from pg_database where datname = ${dbName}`;
    if (!db) {
      await su.unsafe(`create database ${ident(dbName)} owner ${ident(ownerRole)}`);
      log(`created database ${dbName}`);
    }
  } finally {
    await su.end({ timeout: 5 });
  }

  const suDb = new URL(opts.superuserUrl);
  suDb.pathname = `/${dbName}`;
  const sdb = postgres(suDb.toString(), { max: 1, onnotice: () => {} });
  try {
    await sdb.unsafe('create extension if not exists vector');
    await sdb.unsafe('create extension if not exists pg_trgm');
    await sdb.unsafe(`grant connect on database ${ident(dbName)} to ${ident(appRole)}`);
    await sdb.unsafe(`alter schema public owner to ${ident(ownerRole)}`);
    await sdb.unsafe(`revoke create on schema public from public`);
    log('extensions ready');
  } finally {
    await sdb.end({ timeout: 5 });
  }
}
