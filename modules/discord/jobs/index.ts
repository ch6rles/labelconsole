import '../types';
import { defineJob, enqueue } from '@labelconsole/core/queue';
import { readSecret } from '@labelconsole/core/vault';
import { runBenchmark } from '../benchmark';
import { runInteraction } from '../lookup';
import { registerCommands } from '../protocol/rest';
import { runDailyReadings } from '../readings';
import { labelsWithDailyReadings, purgeOld, recordCommandRegistration } from '../service';

export const jobs = [
  defineJob('discord.interaction', (job, data) => runInteraction(job, data)),

  /** Daily, across labels: lookup logs older than six months, spent link codes and evidence past its retention. */
  defineJob('discord.purge', async () => {
    await purgeOld();
  }),

  defineJob('discord.benchmark', (job, data) => runBenchmark(job, data.benchmarkId)),

  /** Daily, across labels: queue each label's readings (one job per label, so one label's failure stays its own). */
  defineJob('discord.readings-all', async () => {
    const day = new Date().toISOString().slice(0, 10);
    for (const l of await labelsWithDailyReadings()) await enqueue('discord.readings', l.orgId, { limit: l.limit }, { jobId: `discord-readings-${l.orgId}-${day}` });
  }),

  defineJob('discord.readings', (job, data) => runDailyReadings(job, data.limit)),

  /** Overwrite the app's global commands. The bot token is only ever decrypted here. */
  defineJob('discord.register-commands', async (job) => {
    const cred = await job.withOrg((ctx) => readSecret(ctx, 'discord'));
    if (!cred) return { skipped: 'Discord is not connected' };
    const applicationId = String(cred.secret.applicationId ?? '');
    try {
      if (!cred.secret.botToken) throw new Error('The Discord integration has no bot token');
      const commands = await registerCommands(applicationId, cred.secret.botToken);
      await job.withOrg((ctx) => recordCommandRegistration(ctx, applicationId, null));
      return { registered: commands?.map((c) => c.name) ?? [] };
    } catch (err) {
      const message = (err as Error).message.slice(0, 300);
      await job.withOrg((ctx) => recordCommandRegistration(ctx, applicationId, message));
      throw err;
    }
  }),
];
