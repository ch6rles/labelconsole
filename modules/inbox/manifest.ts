import type { ModuleManifest } from '@labelconsole/core/modules';

export const manifest: ModuleManifest = {
  id: 'inbox',
  name: 'Inbox and activity',
  description: 'Notifications, the approvals queue, the activity feed and mentions.',
  icon: 'inbox',
  plans: ['starter', 'growth', 'scale'],
  core: true,
  permissions: [{ key: 'inbox:read', description: 'Receive notifications and see the activity feed' }],
  nav: [
    {
      section: { id: 'inbox', label: 'Inbox', icon: 'inbox', sub: 'Notifications, approvals, activity', order: 90 },
      tabs: [
        { id: 'notifications', label: 'Notifications', href: '/inbox', order: 10 },
        { id: 'approvals', label: 'Approvals', href: '/inbox/approvals', order: 20 },
        { id: 'activity', label: 'Activity', href: '/inbox/activity', order: 30 },
      ],
    },
  ],
  events: { emits: ['inbox.notification.created'], listens: ['agents.approval.requested', 'streams.alert', 'documents.key_date.due', 'catalogue.demo.submitted', 'agents.run.failed'] },
  tools: ['inbox_notify_user', 'inbox_request_approval'],
};
