import type { PageProps } from '@labelconsole/core/web';
import { Chip, Icon, Page, PageHeader, Summary } from '@labelconsole/ui';
import { ApiToggle } from '@labelconsole/ui/client';
import * as svc from '../service';

export default async function ModulesPage({ run, session }: PageProps) {
  const list = await run((ctx) => svc.listModules(ctx));
  const canManage = session.permissions.has('settings:manage');
  return (
    <Page variant="narrow">
      <PageHeader title="Modules" description="Switching a module off hides its navigation, rejects its routes and removes its agent tools, without touching other modules or deleting data." />
      <Summary>
        {list.filter((m) => m.enabled).length} of {list.length} on
      </Summary>
      <section className="lc-card">
        {list.map((m) => (
          <div key={m.id} className="lc-setting-row">
            <span className="lc-setting-icon">
              <Icon name={m.icon} />
            </span>
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 3 }}>
              <span className="lc-row" style={{ gap: 8 }}>
                <span style={{ fontSize: 14, fontWeight: 500 }}>{m.name}</span>
                {m.core && <Chip>Core</Chip>}
                {!m.inPlan && !m.core && <Chip tone="muted">Not in plan</Chip>}
              </span>
              <span style={{ fontSize: 12, color: 'var(--lc-muted)' }}>
                {m.description}
                {m.dependsOn.length > 0 && ` Needs ${m.dependsOn.join(', ')}.`}
              </span>
            </div>
            <ApiToggle endpoint={`/settings/modules/${m.id}`} field="enabled" on={m.enabled} disabled={!canManage || m.core} title={m.core ? 'Core modules are always on' : 'Toggle module'} />
          </div>
        ))}
      </section>
    </Page>
  );
}
