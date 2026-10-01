import { closeDb } from '@labelconsole/core/db/client';
import { logger } from '@labelconsole/core/logger';
import { closeQueues } from '@labelconsole/core/queue';
import { closeRedis } from '@labelconsole/core/redis';
import { startWorker } from '@labelconsole/core/worker';
import { serverModules } from './modules';

if (process.env.LC_PROCESS !== 'worker') {
  logger.warn('LC_PROCESS is not "worker"; setting it so the vault can decrypt credentials in this process');
  process.env.LC_PROCESS = 'worker';
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
