import { defineWeb } from '@labelconsole/core/web';
import { manifest } from './manifest';
import AuditPage from './ui/audit';
import BillingPage from './ui/billing';
import ExportPage from './ui/export';
import IntegrationsPage from './ui/integrations';
import ModulesPage from './ui/modules-page';
import RolesPage from './ui/roles';
import UsersPage from './ui/users';
import WorkspacePage from './ui/workspace';

export default defineWeb({
  manifest,
  pages: [
    { path: 'settings', component: WorkspacePage },
    { path: 'settings/integrations', permission: 'settings:read', component: IntegrationsPage },
    { path: 'settings/modules', permission: 'settings:read', component: ModulesPage },
    { path: 'settings/billing', permission: 'settings:read', component: BillingPage },
    { path: 'settings/export', permission: 'settings:export', component: ExportPage },
    { path: 'admin/users', permission: 'settings:read', component: UsersPage },
    { path: 'admin/roles', permission: 'settings:read', component: RolesPage },
    { path: 'admin/audit', permission: 'settings:audit', component: AuditPage },
  ],
});
