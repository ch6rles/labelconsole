import { defineWeb } from '@labelconsole/core/web';
import { manifest } from './manifest';
import DiscordPage from './ui/discord';

export default defineWeb({
  manifest,
  pages: [{ path: 'settings/discord', component: DiscordPage }],
});
