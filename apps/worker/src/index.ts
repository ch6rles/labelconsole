import { closeDb } from '@labelconsole/core/db/client';
import { logger } from '@labelconsole/core/logger';
import { closeQueues } from '@labelconsole/core/queue';
import { closeRedis } from '@labelconsole/core/redis';
import { startWorker } from '@labelconsole/core/worker';
import { serverModules } from './modules';
import { runRelease } from './release';

if (process.env.LC_PROCESS !== 'worker') {
  logger.warn('LC_PROCESS is not "worker"; setting it so the vault can decrypt credentials in this process');
  process.env.LC_PROCESS = 'worker';
}

// Hosts without a separate release step (Railway): set up the database and migrate before starting.
// Idempotent, so it is safe on every start; the web app waits on the schema this creates.
if (process.env.LC_RELEASE_ON_START === '1') {
  await runRelease({ setup: Boolean(process.env.DATABASE_SUPERUSER_URL), migrate: true, log: (m) => logger.info(m) });
}

const runtime = await startWorker({ modules: serverModules });

let stopping = false;
async function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  logger.info({ signal }, 'shutting down: finishing active jobs');
  const force = setTimeout(() => process.exit(1), 60_000);
  try {
    await runtime.stop();
    await closeQueues();
    await closeDb();
    await closeRedis();
  } finally {
    clearTimeout(force);
    process.exit(0);
  }
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('unhandledRejection', (err) => logger.error({ err }, 'unhandled rejection'));
