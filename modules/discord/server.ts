import './types';
import { sql } from 'drizzle-orm';
import { defineModule } from '@labelconsole/core/modules';
import { routes } from './api';
import { jobs } from './jobs';
import { manifest } from './manifest';
import { discordLinks } from './schema';

export default defineModule({
  manifest,
  routes,
  jobs,
  metrics: async (db) => {
    const [r] = await db.select({ n: sql<number>`count(*)::int` }).from(discordLinks);
    return [{ name: 'lc_discord_links', help: 'Discord accounts linked to members', type: 'gauge', samples: [{ value: r?.n ?? 0 }] }];
  },
});
