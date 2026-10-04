import { modules } from '@labelconsole/core/modules';
import type { PageProps } from '@labelconsole/core/web';
import { EmptyState, Icon, LinkButton, Page, PageHeader, Summary, fmt } from '@labelconsole/ui';
import { FilterSelect, SearchInput } from '@labelconsole/ui/client';
import * as svc from '../service';

const ICONS: Array<[RegExp, string]> = [
  [/^workspace|^module/, 'tune'],
  [/^member\.invited/, 'person_add'],
  [/^member\.role/, 'shield_person'],
  [/^member/, 'group'],
  [/^credential/, 'key'],
  [/^release|^track|^demo/, 'album'],
  [/^artist/, 'person'],
  [/^document|^contract|^statement/, 'description'],
  [/^file|^folder/, 'folder'],
  [/^campaign|^card|^pitch/, 'campaign'],
  [/^contact|^interaction/, 'group'],
  [/^agent|^run/, 'smart_toy'],
  [/^approval/, 'approval'],
  [/^export/, 'download'],
  [/split/, 'call_split'],
];

const VERBS: Record<string, string> = {
  'workspace.updated': 'Updated workspace settings for',
  'profile.updated': 'Updated their profile',
  'member.invited': 'Invited',
  'member.role_changed': 'Changed role of',
  'member.removed': 'Removed',
  'member.invite_revoked': 'Revoked invitation for',
  'credential.created': 'Connected',
  'credential.revoked': 'Disconnected',
  'module.enabled': 'Switched on',
  'module.disabled': 'Switched off',
  'export.requested': 'Requested a data export',
  'role.created': 'Created role',
};

function verb(action: string) {
  if (VERBS[action]) return VERBS[action];
  const [entity, act] = action.split('.');
  return `${fmt.titleCase(act ?? '')} ${entity}`.trim();
}

export default async function AuditPage({ run, searchParams }: PageProps) {
  const rows = await run((ctx) => svc.listAudit(ctx, { module: searchParams.module || undefined, q: searchParams.q || undefined, limit: 300 }));
  const groups = new Map<string, typeof rows>();
  const today = new Date().toISOString().slice(0, 10);
  const yesterday = new Date(Date.now() - 86400_000).toISOString().slice(0, 10);
  for (const r of rows) {
    const day = r.createdAt.toISOString().slice(0, 10);
    const label = `${day === today ? 'TODAY · ' : day === yesterday ? 'YESTERDAY · ' : ''}${fmt.shortDate(r.createdAt).toUpperCase()}`;
    groups.set(label, [...(groups.get(label) ?? []), r]);
  }
  const qs = new URLSearchParams(Object.entries(searchParams).filter(([, v]) => v) as [string, string][]).toString();
  return (
    <Page>
      <PageHeader title="Audit log" description="Every change to money, rights and access, newest first. Agent actions link to the run that caused them." actions={<LinkButton href={`/api/v1/settings/audit.csv${qs ? `?${qs}` : ''}`} icon="download" external>Export log</LinkButton>} />
      <div className="lc-toolbar">
        <SearchInput placeholder="Search person, action or record" />
        <FilterSelect param="module" allLabel="All areas" options={modules().map((m) => ({ value: m.manifest.id, label: m.manifest.name }))} />
        <span className="lc-toolbar-end">Times in UTC</span>
      </div>
      <Summary>Showing the latest {rows.length} changes</Summary>
      {rows.length === 0 && <EmptyState icon="history" title="No changes recorded yet" />}
      {[...groups.entries()].map(([day, list]) => (
        <div key={day} className="lc-stack" style={{ gap: 10 }}>
          <span className="lc-section-label">{day}</span>
          <div className="lc-list">
            {list.map((e) => (
              <div key={e.id} className="lc-audit-row">
                <span className="lc-mono lc-muted" style={{ fontSize: 12 }}>
                  {fmt.time(e.createdAt)}
                </span>
                <Icon name={ICONS.find(([re]) => re.test(e.action))?.[1] ?? 'edit'} size={18} style={{ color: 'var(--lc-muted)' }} />
                <span style={{ fontSize: 13, fontWeight: 500 }}>
                  {e.actorType === 'agent' ? (
                    <a href={e.agentRunId ? `/agents/runs/${e.agentRunId}` : '#'}>
                      <Icon name="smart_toy" size={14} /> {e.actorLabel}
                    </a>
                  ) : e.actorType === 'system' ? (
                    'System'
                  ) : (
                    e.actorLabel
                  )}
                </span>
                <span style={{ fontSize: 13, color: 'var(--lc-text-2)' }} title={e.after ? JSON.stringify({ before: e.before, after: e.after }) : undefined}>
                  {verb(e.action)} <span style={{ fontWeight: 600, color: 'var(--lc-ink)' }}>{e.targetLabel ?? ''}</span>
                </span>
                <span className="lc-tag" style={{ justifySelf: 'end' }}>
                  {e.module}
                </span>
              </div>
            ))}
          </div>
        </div>
      ))}
    </Page>
  );
}
