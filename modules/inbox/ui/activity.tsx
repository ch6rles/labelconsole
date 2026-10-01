import type { PageProps } from '@labelconsole/core/web';
import { EmptyState, Icon, Page, PageHeader, fmt } from '@labelconsole/ui';
import { activity } from '../service';

export default async function ActivityPage({ run }: PageProps) {
  const rows = await run((ctx) => activity(ctx, { limit: 200 }));
  const groups = new Map<string, typeof rows>();
  for (const r of rows) {
    const day = fmt.date(r.createdAt).toUpperCase();
    groups.set(day, [...(groups.get(day) ?? []), r]);
  }
  return (
    <Page variant="narrow">
      <PageHeader title="Activity" description="What people and agents changed across the areas you can see." />
      {rows.length === 0 && <EmptyState icon="history" title="No activity yet" />}
      {[...groups.entries()].map(([day, list]) => (
        <div key={day} className="lc-stack" style={{ gap: 10 }}>
          <span className="lc-section-label">{day}</span>
          <div className="lc-list">
            {list.map((e) => (
              <div key={e.id} className="lc-timeline-item">
                <span className="lc-mono lc-muted" style={{ fontSize: 12 }}>
                  {fmt.time(e.createdAt)}
                </span>
                <Icon name={e.actorType === 'agent' ? 'smart_toy' : e.actorType === 'system' ? 'settings' : 'person'} />
                <span>
                  <span style={{ fontWeight: 500 }}>{e.actorType === 'system' ? 'System' : e.actorLabel}</span>{' '}
                  <span style={{ color: 'var(--lc-text-2)' }}>
                    {fmt.titleCase(e.action.split('.').slice(1).join(' '))} {e.action.split('.')[0]}
                  </span>{' '}
                  <span style={{ fontWeight: 600 }}>{e.targetLabel}</span>
                  {e.agentRunId && (
                    <>
                      {' · '}
                      <a href={`/agents/runs/${e.agentRunId}`}>view run</a>
                    </>
                  )}
                </span>
                <span className="lc-tag">{e.module}</span>
              </div>
            ))}
          </div>
        </div>
      ))}
    </Page>
  );
}
