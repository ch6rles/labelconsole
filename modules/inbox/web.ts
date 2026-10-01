import { defineWeb } from '@labelconsole/core/web';
import { manifest } from './manifest';
import ActivityPage from './ui/activity';
import ApprovalsUnavailablePage from './ui/approvals-unavailable';
import NotificationsPage from './ui/notifications';

export default defineWeb({
  manifest,
  pages: [
    { path: 'inbox', component: NotificationsPage },
    { path: 'inbox/activity', component: ActivityPage },
    // The Agents module registers the real page at this path.
    { path: 'inbox/approvals', component: ApprovalsUnavailablePage, fallback: true },
  ],
});
