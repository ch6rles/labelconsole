import '../types';
import { defineJob } from '@labelconsole/core/queue';
import { readSecret } from '@labelconsole/core/vault';
import { runInteraction } from '../lookup';
import { registerCommands } from '../protocol/rest';
import { recordCommandRegistration } from '../service';

export const jobs = [
  defineJob('discord.interaction', (job, data) => runInteraction(job, data)),

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
