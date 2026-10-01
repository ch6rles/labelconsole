import Link from 'next/link';
import type { PageProps } from '@labelconsole/core/web';
import { DataTable, Meter, Page, PageHeader, Summary, fmt, type Column } from '@labelconsole/ui';
import { ActionButton, FilterSelect, FormModal, SearchInput, type FieldSpec } from '@labelconsole/ui/client';
import { MEMORY_KINDS, type Memory } from '../schema';
import * as svc from '../service';

const KIND_LABEL: Record<(typeof MEMORY_KINDS)[number], string> = { fact: 'Fact', outcome: 'Outcome', preference: 'Preference' };
const KIND_TONE: Record<string, string> = { fact: 'lc-chip', outcome: 'lc-chip lc-chip--blue', preference: 'lc-chip lc-chip--ink' };

const editFields: FieldSpec[] = [
  { name: 'content', label: 'What to remember', type: 'textarea', required: true, rows: 4, full: true },
  { name: 'kind', label: 'Kind', type: 'select', required: true, options: MEMORY_KINDS.map((k) => ({ value: k, label: KIND_LABEL[k] })) },
  { name: 'importance', label: 'Importance (0–1)', type: 'number', step: '0.1', min: 0, max: 1, hint: 'Higher is recalled first' },
];

/** What agents remember between runs, and what staff told them to. Staff can correct or delete any of it. */
export default async function MemoryPage({ run, searchParams, session }: PageProps) {
  const agentFilter = searchParams.agent;
  const [rows, agentRows] = await run((ctx) => Promise.all([svc.listMemories(ctx, { agentId: agentFilter, search: searchParams.q }), svc.listAgents(ctx)]));
  const names = new Map(agentRows.map((a) => [a.id, a.name]));
  const canManage = session.permissions.has('agents:manage');
  const orgWide = rows.filter((m) => !m.agentId).length;

  const columns: Column<Memory>[] = [
    {
      key: 'content',
      header: 'Memory',
      width: 'minmax(320px,2.4fr)',
      render: (m) => (
        <span className="lc-cell-stack">
          <span style={{ whiteSpace: 'normal', fontSize: 14 }}>{m.content}</span>
          <span className="lc-cell-sub">
            {m.sourceRunId ? <Link href={`/agents/runs/${m.sourceRunId}`}>from a run</Link> : 'added by staff'} · {fmt.relative(m.createdAt)}
            {m.expiresAt ? ` · expires ${fmt.shortDate(m.expiresAt)}` : ''}
          </span>
        </span>
      ),
    },
    { key: 'kind', header: 'Kind', width: '110px', render: (m) => <span className={KIND_TONE[m.kind] ?? 'lc-chip'}>{KIND_LABEL[m.kind as keyof typeof KIND_LABEL] ?? m.kind}</span> },
    { key: 'agent', header: 'Remembered by', width: 'minmax(140px,1fr)', render: (m) => (m.agentId ? <span className="lc-ellipsis" style={{ display: 'block', minWidth: 0 }}><Link href={`/agents/${m.agentId}`}>{names.get(m.agentId) ?? 'Archived agent'}</Link></span> : <span className="lc-muted">All agents</span>) },
    { key: 'imp', header: 'Importance', width: '120px', render: (m) => <span title={m.importance.toFixed(2)} style={{ width: 80 }}><Meter value={m.importance * 100} /></span> },
    { key: 'used', header: 'Last recalled', width: '120px', render: (m) => <span className="lc-mono" style={{ fontSize: 12, color: 'var(--lc-muted)' }}>{m.lastUsedAt ? fmt.relative(m.lastUsedAt) : 'never'}</span> },
    {
      key: 'actions',
      header: '',
      width: '84px',
      align: 'right',
      render: (m) =>
        canManage && (
          <span className="lc-row" style={{ gap: 4, flexWrap: 'nowrap', justifyContent: 'flex-end' }}>
            <FormModal title="Correct memory" description="Agents read this the next time it's relevant." trigger={{ icon: 'edit', title: 'Edit', variant: 'ghost', size: 'xs' }} endpoint={`/agent-memories/${m.id}`} method="PATCH" fields={editFields} initial={{ content: m.content, kind: m.kind, importance: m.importance }} success="Memory updated" />
            <ActionButton iconOnly icon="delete" title="Forget" variant="danger" endpoint={`/agent-memories/${m.id}`} method="DELETE" confirm="Forget this? Agents won't recall it again." success="Forgotten" />
          </span>
        ),
    },
  ];

  return (
    <Page>
      <PageHeader
        title="Memory"
        description="Facts, outcomes and preferences agents carry between runs. Correct anything that's wrong; agents trust what's here."
        actions={
          canManage && (
            <FormModal
              title="Add a memory"
              description="Org-wide memories are recalled by every agent; pick an agent to keep it to one."
              trigger={{ label: 'Add memory', icon: 'add', variant: 'primary' }}
              endpoint="/agent-memories"
              fields={[
                { name: 'content', label: 'What to remember', type: 'textarea', required: true, rows: 4, full: true, placeholder: 'e.g. Never pitch to playlists that charge for placement' },
                { name: 'agentId', label: 'For', type: 'select', options: agentRows.map((a) => ({ value: a.id, label: a.name })), placeholder: 'All agents' },
                { name: 'kind', label: 'Kind', type: 'select', required: true, options: MEMORY_KINDS.map((k) => ({ value: k, label: KIND_LABEL[k] })) },
                { name: 'importance', label: 'Importance (0–1)', type: 'number', step: '0.1', min: 0, max: 1 },
                { name: 'expiresAt', label: 'Forget after', type: 'date' },
              ]}
              initial={{ kind: 'preference', importance: 0.7, agentId: agentFilter && agentFilter !== 'org' ? agentFilter : '' }}
              success="Memory added"
            />
          )
        }
      />
      <Summary>
        {rows.length} memories shown · {orgWide} shared by all agents
      </Summary>
      <div className="lc-toolbar">
        <FilterSelect param="agent" allLabel="All agents and shared" options={[{ value: 'org', label: 'Shared by all agents' }, ...agentRows.map((a) => ({ value: a.id, label: a.name }))]} minWidth={200} />
        <SearchInput placeholder="Search memories" />
        <span className="lc-toolbar-end">Recall ranks by relevance, importance, then recency</span>
      </div>
      <DataTable rows={rows} rowKey={(m) => m.id} columns={columns} minWidth={980} empty={searchParams.q || agentFilter ? 'No memories match.' : 'Nothing remembered yet. Agents save what they learn as they work; you can add preferences for them here.'} />
    </Page>
  );
}
