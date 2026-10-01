import { defineWeb } from '@labelconsole/core/web';
import { manifest } from './manifest';
import ActivityPage from './ui/activity';
import NotificationsPage from './ui/notifications';

export default defineWeb({
  manifest,
  pages: [
    { path: 'inbox', component: NotificationsPage },
    { path: 'inbox/activity', component: ActivityPage },
  ],
});
