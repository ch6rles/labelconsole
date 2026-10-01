import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import postgres from 'postgres';

/**
 * Logical backups of the Label Console database (plus local file storage).
 *
 * The dump and the row counts in its manifest come from the same exported
 * snapshot, so a restore can be checked table by table even while the app is
 * writing. Secrets stay encrypted in the dump: restoring needs the same vault
 * master key (VAULT_MASTER_KEY / its KMS key), which is never written here.
 */
export type BackupManifest = {
  format: 'labelconsole-backup/1';
  createdAt: string;
  database: string;
  snapshot: string;
  dump: { file: string; bytes: number; sha256: string; seconds: number };
  storage: { kind: 'local'; file: string; bytes: number; sha256: string } | { kind: 's3'; note: string } | { kind: 'none' };
  extensions: string[];
  tables: Record<string, number>;
  migrations: number;
  vaultMasterKeyId: string | null;
};

export function run(cmd: string, args: string[], env: NodeJS.ProcessEnv = process.env) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(cmd, args, { env, stdio: ['ignore', 'inherit', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', reject);
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exited with ${code}: ${stderr.trim().slice(-2000)}`))));
  });
}

export function sha256(file: string) {
  return new Promise<string>((resolve, reject) => {
    const h = createHash('sha256');
    createReadStream(file)
      .on('data', (d) => h.update(d))
      .on('end', () => resolve(h.digest('hex')))
      .on('error', reject);
  });
}

/** Row counts for every table (partitioned parents counted once) plus migrations, inside `tx`. */
export async function tableCounts(tx: postgres.TransactionSql | postgres.Sql) {
  const tables = await tx<Array<{ name: string }>>`
    select c.relname as name from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind in ('r', 'p') and not c.relispartition order by 1`;
  const counts: Record<string, number> = {};
  for (const t of tables) {
    const [row] = await tx.unsafe(`select count(*)::bigint as n from "${t.name.replace(/"/g, '""')}"`);
    counts[t.name] = Number(row.n);
  }
  const [m] = await tx<Array<{ n: string }>>`select count(*)::bigint as n from drizzle.__drizzle_migrations`;
  return { counts, migrations: Number(m.n) };
}

/** pg_dump (custom format) from an exported snapshot, plus a tarball of local storage. */
export async function takeBackup(opts: { url: string; outDir: string; storageDriver?: string; storageDir?: string; vaultMasterKeyId?: string | null }) {
  mkdirSync(opts.outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const base = path.join(opts.outDir, `labelconsole-${stamp}`);
  const dumpFile = `${base}.dump`;
  const sql = postgres(opts.url, { max: 1, onnotice: () => {} });
  try {
    const result = await sql.begin('isolation level repeatable read read only', async (tx) => {
      const [{ snap }] = await tx<Array<{ snap: string }>>`select pg_export_snapshot() as snap`;
      const { counts, migrations } = await tableCounts(tx);
      const extensions = (await tx<Array<{ extname: string }>>`select extname from pg_extension where extname <> 'plpgsql' order by 1`).map((e) => e.extname);
      const [{ db }] = await tx<Array<{ db: string }>>`select current_database() as db`;
      // The snapshot only stays importable while this transaction is open.
      const t0 = Date.now();
      await run('pg_dump', ['--format=custom', '--compress=6', `--snapshot=${snap}`, `--file=${dumpFile}`, opts.url]);
      return { snap, counts, migrations, extensions, db, seconds: (Date.now() - t0) / 1000 };
    });

    let storage: BackupManifest['storage'] = { kind: 'none' };
    if (opts.storageDriver === 's3') {
      storage = { kind: 's3', note: 'Object storage is not copied here: keep bucket versioning and cross-region replication (or provider snapshots) on, and restore files from there.' };
    } else if (opts.storageDir && existsSync(opts.storageDir)) {
      const file = `${base}.storage.tar.gz`;
      await run('tar', ['-czf', file, '-C', opts.storageDir, '.']);
      storage = { kind: 'local', file: path.basename(file), bytes: statSync(file).size, sha256: await sha256(file) };
    }

    const manifest: BackupManifest = {
      format: 'labelconsole-backup/1',
      createdAt: new Date().toISOString(),
      database: result.db,
      snapshot: result.snap,
      dump: { file: path.basename(dumpFile), bytes: statSync(dumpFile).size, sha256: await sha256(dumpFile), seconds: result.seconds },
      storage,
      extensions: result.extensions,
      tables: result.counts,
      migrations: result.migrations,
      vaultMasterKeyId: opts.vaultMasterKeyId ?? null,
    };
    const manifestFile = `${base}.manifest.json`;
    writeFileSync(manifestFile, JSON.stringify(manifest, null, 2) + '\n');
    return { manifest, manifestFile, dumpFile };
  } finally {
    await sql.end({ timeout: 5 });
  }
}

/** Swap the database name in a connection URL. */
export function withDatabase(url: string, db: string) {
  const u = new URL(url);
  u.pathname = `/${db}`;
  return u.toString();
}
