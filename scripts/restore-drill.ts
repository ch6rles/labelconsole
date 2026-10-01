/**
 * Restore drill: prove a backup can actually be restored and used.
 *
 *   pnpm db:restore-drill                                  # back up now, then restore that
 *   pnpm db:restore-drill -- --from backups/x.manifest.json  # restore an existing backup
 *   pnpm db:restore-drill -- --keep                          # leave the scratch database for inspection
 *
 * It restores into a fresh scratch database on the same server and checks:
 *   1. every table has exactly the row count recorded in the backup's snapshot
 *   2. the migration history matches
 *   3. row-level security still isolates labels for the app role
 *   4. the vault still decrypts every key and credential with this
 *      environment's master key
 * Timings and results go to test-results/restore-drill.json. The scratch
 * database is dropped afterwards unless --keep is passed.
 */
import 'dotenv/config';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { verifyVault } from '@labelconsole/core/vault';
import { run, sha256, tableCounts, takeBackup, withDatabase, type BackupManifest } from './lib/backup';

const arg = (name: string) => {
  const i = process.argv.indexOf(name);
  return i > -1 ? process.argv[i + 1] : undefined;
};
const keep = process.argv.includes('--keep');
const SYSTEM_URL = process.env.DATABASE_SYSTEM_URL!;
const APP_URL = process.env.DATABASE_URL!;
const SUPER_URL = process.env.DATABASE_SUPERUSER_URL!;
for (const [k, v] of Object.entries({ DATABASE_SYSTEM_URL: SYSTEM_URL, DATABASE_URL: APP_URL, DATABASE_SUPERUSER_URL: SUPER_URL })) {
  if (!v) {
    console.error(`[restore-drill] ${k} is not set`);
    process.exit(1);
  }
}

const log = (m: string) => console.log(`[restore-drill] ${m}`);
const checks: Array<{ check: string; ok: boolean; detail: string }> = [];
const check = (name: string, ok: boolean, detail: string) => {
  checks.push({ check: name, ok, detail });
  log(`${ok ? 'PASS' : 'FAIL'} ${name}: ${detail}`);
};

// 1. The backup to restore.
let manifestFile = arg('--from');
let backupSeconds: number | null = null;
if (!manifestFile) {
  const t0 = Date.now();
  const taken = await takeBackup({ url: SYSTEM_URL, outDir: path.join(os.tmpdir(), 'labelconsole-drill'), storageDriver: process.env.STORAGE_DRIVER, vaultMasterKeyId: process.env.VAULT_MASTER_KEY_ID ?? null });
  manifestFile = taken.manifestFile;
  backupSeconds = (Date.now() - t0) / 1000;
  log(`backed up ${taken.manifest.database} in ${backupSeconds.toFixed(1)}s (${(taken.manifest.dump.bytes / 1e6).toFixed(1)} MB)`);
}
const manifest = JSON.parse(readFileSync(manifestFile, 'utf8')) as BackupManifest;
const dumpFile = path.join(path.dirname(manifestFile), manifest.dump.file);
check('dump checksum', (await sha256(dumpFile)) === manifest.dump.sha256, manifest.dump.sha256.slice(0, 16));

// 2. A scratch database owned by the same role as production, with the same extensions.
const owner = decodeURIComponent(new URL(SYSTEM_URL).username);
const scratch = `labelconsole_drill_${Date.now().toString(36)}`;
if (scratch === manifest.database) throw new Error('refusing to restore over the source database');
const superSql = postgres(SUPER_URL, { max: 1, onnotice: () => {} });
await superSql.unsafe(`create database "${scratch}" owner "${owner}"`);
const scratchSuper = postgres(withDatabase(SUPER_URL, scratch), { max: 1, onnotice: () => {} });
for (const ext of manifest.extensions) await scratchSuper.unsafe(`create extension if not exists "${ext}"`);
await scratchSuper.end();

const ownerUrl = withDatabase(SYSTEM_URL, scratch);
const appUrl = withDatabase(APP_URL, scratch);
let restoreSeconds = 0;
try {
  // 3. Restore as the owner role, so ownership and grants match the original.
  const t0 = Date.now();
  await run('pg_restore', ['--no-owner', '--no-comments', '--exit-on-error', '--jobs=4', `--dbname=${ownerUrl}`, dumpFile]);
  restoreSeconds = (Date.now() - t0) / 1000;
  log(`restored into ${scratch} in ${restoreSeconds.toFixed(1)}s`);

  const ownerSql = postgres(ownerUrl, { max: 1, onnotice: () => {} });
  try {
    // 4a. Row counts, table by table.
    const { counts, migrations } = await tableCounts(ownerSql);
    const mismatched = Object.keys({ ...manifest.tables, ...counts }).filter((t) => manifest.tables[t] !== counts[t]);
    const total = Object.values(counts).reduce((a, n) => a + n, 0);
    check('row counts', mismatched.length === 0, mismatched.length ? `differ in ${mismatched.map((t) => `${t} (${manifest.tables[t]} → ${counts[t]})`).join(', ')}` : `${Object.keys(counts).length} tables, ${total} rows identical`);
    check('migrations', migrations === manifest.migrations, `${migrations} applied (backup had ${manifest.migrations})`);

    // 4b. RLS for the app role: nothing without a label, only that label's rows with one.
    const [top] = await ownerSql<Array<{ org_id: string; n: string }>>`select org_id, count(*)::bigint as n from releases group by org_id order by 2 desc limit 1`;
    const appSql = postgres(appUrl, { max: 1, onnotice: () => {} });
    try {
      const [none] = await appSql<Array<{ n: string }>>`select count(*)::bigint as n from releases`;
      const scoped = top
        ? await appSql.begin(async (tx) => {
            await tx`select set_config('app.org_id', ${top.org_id}, true)`;
            const [r] = await tx<Array<{ n: string; other: string }>>`select count(*)::bigint as n, count(*) filter (where org_id <> ${top.org_id})::bigint as other from releases`;
            return r;
          })
        : { n: '0', other: '0' };
      const ok = Number(none.n) === 0 && Number(scoped.n) === Number(top?.n ?? 0) && Number(scoped.other) === 0;
      check('row-level security', ok, top ? `app role sees 0 releases without a label and exactly ${scoped.n} of its own with one` : 'no releases to test against; policies restored');
    } finally {
      await appSql.end();
    }

    // 4c. The vault decrypts with this environment's master key.
    process.env.LC_ALLOW_DECRYPT = '1';
    const vault = await verifyVault(drizzle(ownerSql));
    check('vault', vault.failures.length === 0, vault.failures.length ? vault.failures.join('; ') : `${vault.orgKeys} label keys unwrap, ${vault.credentials} credentials decrypt (master key ${process.env.VAULT_MASTER_KEY_ID ?? 'unknown'})`);
  } finally {
    await ownerSql.end();
  }
} finally {
  if (!keep) {
    await superSql.unsafe(`drop database if exists "${scratch}" with (force)`);
    log(`dropped ${scratch}`);
  } else log(`kept ${scratch} for inspection`);
  await superSql.end();
}

const ok = checks.every((c) => c.ok);
const summary = { at: new Date().toISOString(), ok, source: manifest.database, backup: { manifest: manifestFile, bytes: manifest.dump.bytes, seconds: backupSeconds ?? manifest.dump.seconds }, restoreSeconds, checks };
mkdirSync('test-results', { recursive: true });
writeFileSync('test-results/restore-drill.json', JSON.stringify(summary, null, 2) + '\n');
log(ok ? 'drill passed' : 'drill FAILED');
process.exit(ok ? 0 : 1);
