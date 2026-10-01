import Link from 'next/link';
import { llmConfigured } from '@labelconsole/core/usage';
import type { PageProps } from '@labelconsole/core/web';
import { Banner, DataTable, Icon, Page, PageHeader, Summary, fmt, type Column } from '@labelconsole/ui';
import { ActionButton, FormModal } from '@labelconsole/ui/client';
import * as svc from '../service';
import { LiveRefresh } from './live';
import { RunChip, usd } from './shared';

type Row = Awaited<ReturnType<typeof svc.listAgents>>[number];

export default async function AgentsPage({ run, session }: PageProps) {
  const [rows, killed, pending, hasModel] = await run((ctx) => Promise.all([svc.listAgents(ctx), svc.killSwitchState(ctx), svc.pendingApprovalCount(ctx), llmConfigured(ctx)]));
  const can = (p: string) => session.permissions.has(p);
  const spentToday = rows.reduce((a, r) => a + r.costTodayUsd, 0);
  const active = rows.filter((r) => r.lastRun && ['queued', 'running', 'waiting_approval', 'waiting_child'].includes(r.lastRun.status)).length;

  const columns: Column<Row>[] = [
    {
      key: 'name',
      header: 'Agent',
      width: 'minmax(220px,1.3fr)',
      render: (a) => (
        <span className="lc-cell-media">
          <span className="lc-cover"><Icon name={a.icon} /></span>
          <span className="lc-cell-stack">
            <span className="lc-cell-strong lc-ellipsis">{a.name}</span>
            <span className="lc-cell-sub lc-ellipsis">{a.typeName}</span>
          </span>
        </span>
      ),
    },
    { key: 'status', header: 'Status', width: '100px', render: (a) => <span className={a.status === 'active' ? 'lc-chip lc-chip--blue' : 'lc-chip lc-chip--muted'}>{fmt.titleCase(a.status)}</span> },
    {
      key: 'task',
      header: 'Current task',
      width: 'minmax(220px,1.4fr)',
      render: (a) =>
        a.lastRun ? (
          <span className="lc-row" style={{ gap: 8, flexWrap: 'nowrap', minWidth: 0 }}>
            <RunChip status={a.lastRun.status} />
            <span className="lc-cell-sub lc-ellipsis">{(a.lastRun.status === 'completed' ? a.lastRun.result : null) ?? a.lastRun.currentTask ?? a.lastRun.endReason ?? ''}</span>
          </span>
        ) : (
          <span className="lc-muted" style={{ fontSize: 13 }}>Never run</span>
        ),
    },
    { key: 'last', header: 'Last run', width: '110px', render: (a) => <span className="lc-mono" style={{ fontSize: 12, color: 'var(--lc-muted)' }}>{a.lastRun ? fmt.relative(a.lastRun.createdAt) : '—'}</span> },
    { key: 'next', header: 'Next run', width: '130px', render: (a) => <span className="lc-mono" style={{ fontSize: 12, color: 'var(--lc-muted)' }}>{a.nextRunAt ? `${fmt.shortDate(a.nextRunAt)} ${fmt.time(a.nextRunAt)}` : 'on events'}</span> },
    { key: 'cost', header: 'Cost today', width: '110px', align: 'right', render: (a) => <span className="lc-cell-num">{usd(a.costTodayUsd)} <span className="lc-muted">/ {usd(a.budget.perDayUsd)}</span></span> },
  ];

  return (
    <Page>
      <LiveRefresh />
      <PageHeader
        title="Agents"
        description="Autonomous agents that work through the label's own systems, with the same permissions as staff. Risky actions wait for a person."
        actions={
          <>
            {can('agents:manage') &&
              (killed ? (
                <ActionButton endpoint="/agents-kill-switch" body={{ paused: false }} label="Let agents run again" icon="play_arrow" success="Agents can run again" />
              ) : (
                <ActionButton endpoint="/agents-kill-switch" body={{ paused: true }} label="Stop all agents" icon="emergency_home" variant="danger" confirm="Stop every agent in the label now? Running work is interrupted and nothing new starts until you turn them back on." success="All agents stopped" />
              ))}
            {can('agents:manage') && <Link href="/agents/new" className="lc-btn lc-btn--primary"><Icon name="add" />New agent</Link>}
          </>
        }
      />
      {!hasModel && (
        <Banner icon="key" warn>
          No Anthropic API key is configured, so runs will fail at their first step. {session.permissions.has('settings:credentials') ? <Link href="/settings/integrations">Add the label's key under Integrations</Link> : 'Ask an admin to add one under Settings → Integrations'}.
        </Banner>
      )}
      {killed && <Banner icon="emergency_home" warn>The kill switch is on: no agent runs until someone turns it off.</Banner>}
      <Summary>
        {rows.length} agents · {active} working now · {pending ? <Link href="/inbox/approvals">{pending} action{pending === 1 ? '' : 's'} waiting for approval</Link> : 'no approvals waiting'} · {usd(spentToday)} spent today
      </Summary>
      <DataTable rows={rows} rowKey={(a) => a.id} rowHref={(a) => `/agents/${a.id}`} columns={columns} minWidth={1020} empty="No agents yet. Start from one of the eight agent types; each comes with sensible tools, approvals and triggers you can change." />
      {can('agents:run') && rows.length > 0 && (
        <div className="lc-row" style={{ gap: 8 }}>
          <FormModal
            title="Run an agent now"
            trigger={{ label: 'Run an agent now', icon: 'play_circle' }}
            endpoint="/agents/{agentId}/run"
            fields={[
              { name: 'agentId', label: 'Agent', type: 'select', required: true, options: rows.filter((r) => r.status === 'active').map((r) => ({ value: r.id, label: r.name })) },
              { name: 'task', label: 'Task (optional)', type: 'textarea', placeholder: 'Leave empty to work toward its goal' },
            ]}
            columns={1}
            redirectTo="/agents/runs/{id}"
            success="Run started"
          />
        </div>
      )}
    </Page>
  );
}
