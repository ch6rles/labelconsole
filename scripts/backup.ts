/**
 * Take a backup: a pg_dump of the database plus (for local storage) a tarball
 * of uploaded files, with a manifest of row counts from the same snapshot.
 *
 *   pnpm db:backup                 # writes to ./backups
 *   pnpm db:backup -- --out /mnt/backups
 *
 * Schedule it (cron, a Kubernetes CronJob, your platform's scheduler) and ship
 * the files off-site. Verify regularly with `pnpm db:restore-drill`.
 */
import 'dotenv/config';
import path from 'node:path';
import { takeBackup } from './lib/backup';

const outArg = process.argv.indexOf('--out');
const outDir = path.resolve(outArg > -1 ? process.argv[outArg + 1] : (process.env.BACKUP_DIR ?? 'backups'));
const url = process.env.DATABASE_SYSTEM_URL;
if (!url) {
  console.error('[db:backup] DATABASE_SYSTEM_URL is not set');
  process.exit(1);
}

const { manifest, manifestFile } = await takeBackup({
  url,
  outDir,
  storageDriver: process.env.STORAGE_DRIVER,
  storageDir: process.env.STORAGE_LOCAL_DIR ? path.resolve(process.env.STORAGE_LOCAL_DIR) : undefined,
  vaultMasterKeyId: process.env.VAULT_MASTER_KEY_ID ?? null,
});
const size = (b: number) => (b < 1e6 ? `${(b / 1e3).toFixed(0)} KB` : `${(b / 1e6).toFixed(1)} MB`);
const rows = Object.values(manifest.tables).reduce((a, n) => a + n, 0);
console.log(`[db:backup] ${manifest.dump.file}: ${size(manifest.dump.bytes)}, ${Object.keys(manifest.tables).length} tables, ${rows} rows, ${manifest.dump.seconds.toFixed(1)}s`);
if (manifest.storage.kind === 'local') console.log(`[db:backup] ${manifest.storage.file}: ${size(manifest.storage.bytes)} of uploaded files`);
console.log(`[db:backup] manifest: ${manifestFile}`);
console.log('[db:backup] restoring needs the same vault master key (id ' + (manifest.vaultMasterKeyId ?? 'unknown') + '); it is not in the backup.');
