import type { ModuleManifest } from '@labelconsole/core/modules';

export const manifest: ModuleManifest = {
  id: 'settings',
  name: 'Settings and admin',
  description: 'Label profile, members and roles, integrations, credentials vault, billing, audit log and data export.',
  icon: 'settings',
  plans: ['starter', 'growth', 'scale'],
  core: true,
  permissions: [
    { key: 'settings:read', description: 'View workspace settings' },
    { key: 'settings:manage', description: 'Edit the label profile, modules and integrations' },
    { key: 'settings:members', description: 'Invite members and change roles', sensitive: true },
    { key: 'settings:credentials', description: 'Add and revoke third-party credentials', sensitive: true },
    { key: 'settings:billing', description: 'Change plan and billing', sensitive: true },
    { key: 'settings:audit', description: 'View the audit log' },
    { key: 'settings:export', description: 'Export all label data', sensitive: true },
  ],
  nav: [
    {
      section: { id: 'admin', label: 'Admin', icon: 'manage_accounts', sub: 'Users and permissions', order: 100 },
      tabs: [
        { id: 'users', label: 'Users', href: '/admin/users', permission: 'settings:read', order: 10 },
        { id: 'roles', label: 'Roles', href: '/admin/roles', permission: 'settings:read', order: 20 },
        { id: 'audit', label: 'Audit Log', href: '/admin/audit', permission: 'settings:audit', order: 30 },
      ],
    },
    {
      section: { id: 'settings', label: 'Settings', icon: 'settings', sub: 'Workspace, apps, integrations', order: 110 },
      tabs: [
        { id: 'workspace', label: 'Workspace', href: '/settings', order: 10 },
        { id: 'integrations', label: 'Integrations', href: '/settings/integrations', permission: 'settings:read', order: 20 },
        { id: 'modules', label: 'Modules', href: '/settings/modules', permission: 'settings:read', order: 30 },
        { id: 'billing', label: 'Plan & usage', href: '/settings/billing', permission: 'settings:read', order: 40 },
        { id: 'export', label: 'Data export', href: '/settings/export', permission: 'settings:export', order: 50 },
      ],
    },
  ],
  events: { emits: ['settings.member.invited', 'settings.member.role_changed', 'settings.export.ready'], listens: [] },
  tools: [],
};
