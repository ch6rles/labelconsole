import type { PageProps } from '@labelconsole/core/web';
import { BarChart, Card, DataTable, FilterPills, Page, PageHeader, Summary, fmt } from '@labelconsole/ui';
import * as svc from '../service';
import { LiveRefresh } from './live';
import { RunChip, TRIGGER_LABEL, usd, usdShort } from './shared';

export default async function RunsPage({ run, searchParams, path }: PageProps) {
  const status = searchParams.status;
  const [rows, use] = await run((ctx) => Promise.all([svc.listRuns(ctx, { status, agentId: searchParams.agent, limit: 200 }), svc.usage(ctx, 30)]));
  const days = Array.from({ length: 30 }, (_, i) => new Date(Date.now() - (29 - i) * 86400_000).toISOString().slice(0, 10));
  const pill = (label: string, s?: string) => ({ label, href: s ? `${path}?status=${s}` : path, active: status === s });

  return (
    <Page>
      <LiveRefresh />
      <PageHeader title="Runs" description="Every agent run with its trigger, steps and cost. Open one to watch it live." />
      <Summary>
        {usd(use.monthUsd)} spent this month{use.monthlyBudgetUsd != null ? ` of a ${usd(use.monthlyBudgetUsd)} cap` : ''} · {use.byDay.reduce((a, d) => a + d.runs, 0)} runs in 30 days
      </Summary>
      <Card title="Cost per day · 30 days">
        <BarChart data={days.map((d) => ({ label: d.slice(8), value: use.byDay.find((x) => x.day === d)?.costUsd ?? 0 }))} height={150} format={usdShort} />
      </Card>
      <FilterPills items={[pill('All'), pill('Active', 'active'), pill('Needs approval', 'waiting_approval'), pill('Completed', 'completed'), pill('Failed', 'failed'), pill('Over budget', 'budget_exceeded')]} />
      <DataTable
        rows={rows}
        rowKey={(r) => r.run.id}
        rowHref={(r) => `/agents/runs/${r.run.id}`}
        minWidth={1000}
        empty="No runs match."
        columns={[
          { key: 'a', header: 'Agent', width: 'minmax(160px,1fr)', render: (r) => <span className="lc-cell-strong lc-ellipsis">{r.agentName}</span> },
          { key: 's', header: 'Status', width: '140px', render: (r) => <RunChip status={r.run.status} /> },
          { key: 't', header: 'Task', width: 'minmax(240px,1.8fr)', render: (r) => <span className="lc-cell-stack"><span className="lc-ellipsis">{r.run.task ?? 'Scheduled work'}</span><span className="lc-cell-sub lc-ellipsis">{r.run.currentTask ?? ''}</span></span> },
          { key: 'k', header: 'Trigger', width: '100px', render: (r) => <span style={{ fontSize: 13 }}>{TRIGGER_LABEL[r.run.triggerKind] ?? r.run.triggerKind}{r.run.parentRunId ? ' ↳' : ''}</span> },
          { key: 'n', header: 'Steps', width: '70px', align: 'right', render: (r) => <span className="lc-cell-num">{r.run.stepCount}</span> },
          { key: 'tok', header: 'Tokens', width: '100px', align: 'right', render: (r) => <span className="lc-cell-num lc-muted">{fmt.compact(r.run.tokensIn + r.run.tokensOut)}</span> },
          { key: 'c', header: 'Cost', width: '80px', align: 'right', render: (r) => <span className="lc-cell-num">{usd(r.run.costUsd)}</span> },
          { key: 'd', header: 'Started', width: '110px', render: (r) => <span className="lc-mono" style={{ fontSize: 12, color: 'var(--lc-muted)' }}>{fmt.relative(r.run.createdAt)}</span> },
        ]}
      />
    </Page>
  );
}
