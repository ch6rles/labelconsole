import { modules } from '@labelconsole/core/modules';
import { ROLE_LABELS, type BuiltInRole } from '@labelconsole/core/permissions';
import type { PageProps } from '@labelconsole/core/web';
import { Card, KV, Page, PageHeader } from '@labelconsole/ui';
import { AutoSaveFields } from '@labelconsole/ui/client';
import * as svc from '../service';
import { SidebarApps } from './client';

const CURRENCIES = ['USD', 'EUR', 'GBP', 'SEK', 'AUD', 'CAD', 'JPY'].map((c) => ({ value: c, label: c }));

export default async function WorkspacePage({ run, session, enabled }: PageProps) {
  const org = await run((ctx) => svc.getWorkspace(ctx));
  const canManage = session.permissions.has('settings:manage');
  const s = org.settings;
  const widgets = modules()
    .filter((m) => enabled.has(m.manifest.id))
    .flatMap((m) => m.widgets ?? [])
    .filter((w) => !w.permission || session.permissions.has(w.permission))
    .map((w) => ({ id: w.id, name: w.name, icon: w.icon, desc: w.desc }));

  const labelInitial = { name: org.name, shortCode: s.shortCode, legalEntity: s.legalEntity, distributor: s.distributor, currency: s.currency ?? 'USD', siteUrl: s.siteUrl, timezone: s.timezone ?? 'UTC' };
  return (
    <Page variant="narrow">
      <PageHeader title="Workspace" description="Changes save automatically and apply across every app." />
      <Card title="Label" sub="Shown in the sidebar, statements and the public site.">
        {canManage ? (
          <AutoSaveFields
            endpoint="/settings/workspace"
            initial={labelInitial}
            fields={[
              { name: 'name', label: 'Label name' },
              { name: 'shortCode', label: 'Short code' },
              { name: 'legalEntity', label: 'Legal entity' },
              { name: 'distributor', label: 'Distributor' },
              { name: 'currency', label: 'Default currency', type: 'select', options: CURRENCIES, required: true },
              { name: 'siteUrl', label: 'Public site' },
              { name: 'timezone', label: 'Time zone', placeholder: 'Europe/Amsterdam' },
            ]}
          />
        ) : (
          Object.entries(labelInitial).map(([k, v]) => <KV key={k} k={k} v={String(v ?? '—')} />)
        )}
      </Card>
      <Card title="Account" sub="Your profile inside this workspace.">
        <AutoSaveFields endpoint="/settings/profile" initial={{ name: session.user.name }} fields={[{ name: 'name', label: 'Name' }]} />
        <div style={{ marginTop: 12 }}>
          <KV k="Role" v={ROLE_LABELS[session.membership.role as BuiltInRole] ?? session.membership.role} />
          <KV k="Email" v={session.user.email} />
        </div>
      </Card>
      {canManage && (
        <Card title="Tracking and agents" sub="How often stream counts refresh, and the monthly ceiling on agent spend.">
          <AutoSaveFields
            endpoint="/settings/workspace"
            initial={{ streamPollHoursActive: s.streamPollHoursActive ?? 6, streamPollHoursCatalogue: s.streamPollHoursCatalogue ?? 24, agentMonthlyBudgetUsd: s.agentMonthlyBudgetUsd ?? null }}
            fields={[
              { name: 'streamPollHoursActive', label: 'Poll hours · active campaigns', type: 'number', min: 1, max: 168 },
              { name: 'streamPollHoursCatalogue', label: 'Poll hours · back catalogue', type: 'number', min: 1, max: 720 },
              { name: 'agentMonthlyBudgetUsd', label: 'Agent budget · USD per month', type: 'number', min: 0, hint: 'Empty means no label-wide cap; per-agent budgets still apply.' },
            ]}
          />
        </Card>
      )}
      <SidebarApps orgId={session.org.id} widgets={widgets} />
    </Page>
  );
}
