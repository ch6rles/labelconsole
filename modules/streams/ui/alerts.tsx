import Link from 'next/link';
import type { PageProps } from '@labelconsole/core/web';
import { DataTable, FilterPills, Page, PageHeader, Section, fmt } from '@labelconsole/ui';
import { ActionButton, ApiToggle, FormModal, type FieldSpec } from '@labelconsole/ui/client';
import * as svc from '../service';
import { platformLabel } from '../sources/types';

const RULE_FIELDS: FieldSpec[] = [
  { name: 'name', label: 'Name', required: true, full: true },
  { name: 'kind', label: 'Kind', type: 'select', required: true, options: [{ value: 'spike', label: 'Spike: daily plays up by %' }, { value: 'drop', label: 'Drop: daily plays down by %' }, { value: 'milestone', label: 'Milestone: total passes a number' }] },
  { name: 'threshold', label: 'Threshold', type: 'number', required: true, hint: 'Percent for spikes and drops; a play count for milestones' },
  { name: 'windowDays', label: 'Compare with the last … days', type: 'number', min: 3, max: 60 },
  { name: 'minDaily', label: 'Ignore below … plays a day', type: 'number', min: 0 },
  { name: 'platform', label: 'Platform', type: 'select', options: [{ value: 'youtube', label: 'YouTube' }, { value: 'spotify', label: 'Spotify' }, { value: 'apple_music', label: 'Apple Music' }], hint: 'Leave empty for every platform' },
];

export default async function StreamAlertsPage({ run, session, searchParams, path }: PageProps) {
  const open = searchParams.show !== 'all';
  const [list, rules] = await run((ctx) => Promise.all([svc.listAlerts(ctx, { open: open ? '1' : undefined }), svc.listRules(ctx)]));
  const canManage = session.permissions.has('streams:manage');
  const describe = (r: (typeof rules)[number]) =>
    r.kind === 'milestone' ? `Total passes ${fmt.compact(Number(r.threshold))}` : `Daily plays ${r.kind === 'spike' ? 'up' : 'down'} ${Number(r.threshold)}% vs the ${r.windowDays}-day average, from ${fmt.compact(r.minDaily)} a day`;

  return (
    <Page>
      <PageHeader
        title="Alerts"
        description="Spikes and drops compare yesterday with the days before; milestones fire once when a total crosses the line. People with stream management are notified in the Inbox."
        actions={canManage && <FormModal title="New alert rule" trigger={{ label: 'New rule', icon: 'add', variant: 'primary' }} endpoint="/streams/alert-rules" fields={RULE_FIELDS} initial={{ kind: 'spike', threshold: 150, windowDays: 7, minDaily: 200 }} success="Rule added" />}
      />
      <FilterPills items={[{ label: 'Open', href: path, active: open }, { label: 'All', href: `${path}?show=all`, active: !open }]} />
      <DataTable
        rows={list}
        rowKey={(a) => a.id}
        minWidth={900}
        empty={open ? 'No open alerts.' : 'No alerts yet.'}
        columns={[
          { key: 'k', header: 'Kind', width: '110px', render: (a) => <span className={a.kind === 'drop' ? 'lc-chip lc-chip--red' : a.kind === 'spike' ? 'lc-chip lc-chip--blue' : 'lc-chip lc-chip--ink'}>{fmt.titleCase(a.kind)}</span> },
          { key: 't', header: 'Track', width: 'minmax(180px,1fr)', render: (a) => <span className="lc-cell-stack"><Link href={`/streams/tracks/${a.trackId}`} className="lc-cell-strong" style={{ color: 'var(--lc-ink)' }}>{a.trackTitle}</Link><span className="lc-cell-sub">{a.artists.join(', ') || '—'} · {platformLabel(a.platform)}</span></span> },
          { key: 'm', header: 'What happened', width: 'minmax(260px,2fr)', render: (a) => <span style={{ fontSize: 13 }}>{a.message}</span> },
          { key: 'd', header: 'Day', width: '110px', render: (a) => <span className="lc-mono" style={{ fontSize: 12 }}>{fmt.date(a.day)}</span> },
          { key: 'a', header: '', width: '110px', align: 'right', render: (a) => (a.acknowledgedAt ? <span className="lc-muted" style={{ fontSize: 12 }}>Seen</span> : <ActionButton endpoint={`/streams/alerts/${a.id}/ack`} label="Mark seen" size="sm" variant="ghost" />) },
        ]}
      />
      <Section title="Rules">
        <DataTable
          rows={rules}
          rowKey={(r) => r.id}
          minWidth={760}
          columns={[
            { key: 'n', header: 'Rule', width: 'minmax(180px,1fr)', render: (r) => <span className="lc-cell-stack"><span className="lc-cell-strong">{r.name}</span><span className="lc-cell-sub">{describe(r)}</span></span> },
            { key: 'p', header: 'Platform', width: '130px', render: (r) => <span style={{ fontSize: 13 }}>{r.platform ? platformLabel(r.platform) : 'All'}</span> },
            { key: 'e', header: 'On', width: '70px', render: (r) => <ApiToggle endpoint={`/streams/alert-rules/${r.id}`} field="enabled" on={r.enabled} disabled={!canManage} title="Enabled" /> },
            { key: 'x', header: '', width: '60px', align: 'right', render: (r) => (canManage ? <ActionButton iconOnly icon="delete" title="Delete rule" variant="danger" endpoint={`/streams/alert-rules/${r.id}`} method="DELETE" confirm={`Delete the rule "${r.name}"?`} success="Rule deleted" /> : null) },
          ]}
        />
      </Section>
    </Page>
  );
}
