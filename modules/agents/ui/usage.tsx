import Link from 'next/link';
import type { PageProps } from '@labelconsole/core/web';
import { BarChart, Card, DataTable, Progress, Page, PageHeader, ShareBars, StatCard, fmt } from '@labelconsole/ui';
import * as svc from '../service';
import { usd, usdShort } from './shared';

/** What agents cost: this month against the label's cap, per day, and per agent. */
export default async function UsagePage({ run, session }: PageProps) {
  const [use, agentRows] = await run((ctx) => Promise.all([svc.usage(ctx, 30), svc.listAgents(ctx)]));
  const days = Array.from({ length: 30 }, (_, i) => new Date(Date.now() - (29 - i) * 86400_000).toISOString().slice(0, 10));
  const today = days[days.length - 1];
  const todayUsd = use.byDay.find((d) => d.day === today)?.costUsd ?? 0;
  const total30 = use.byAgent.reduce((a, r) => a + r.cost, 0);
  const runs30 = use.byAgent.reduce((a, r) => a + r.runs, 0);
  const failed30 = use.byAgent.reduce((a, r) => a + r.failed, 0);
  const cap = use.monthlyBudgetUsd;
  const capPct = cap ? Math.min(100, (use.monthUsd / cap) * 100) : 0;
  // Month to date plus the trailing 7-day daily average for the days left (steadier than extrapolating from the 1st).
  const now = new Date();
  const daysLeft = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).getUTCDate() - now.getUTCDate();
  const avg7 = days.slice(-7).reduce((a, d) => a + (use.byDay.find((x) => x.day === d)?.costUsd ?? 0), 0) / 7;
  const projected = use.monthUsd + avg7 * daysLeft;
  const budgets = new Map(agentRows.map((a) => [a.id, a]));

  return (
    <Page>
      <PageHeader
        title="Usage"
        description="Model spend across every agent run, including delegated work. Budgets stop runs before they overspend; nothing is billed beyond them."
        actions={session.permissions.has('settings:write') && <Link className="lc-btn" href="/settings/workspace">Monthly cap</Link>}
      />
      <div className="lc-grid-stats">
        <StatCard label="THIS MONTH" icon="payments" value={usd(use.monthUsd)} note={cap != null ? `of ${usd(cap)} cap · ${capPct.toFixed(0)}% used` : 'no label-wide cap'} />
        <StatCard label="PROJECTED" icon="trending_up" value={usd(projected)} note={cap != null && projected > cap ? 'on pace to hit the cap' : `by the end of ${now.toLocaleString('en', { month: 'long', timeZone: 'UTC' })}`} deltaDown={cap != null && projected > cap} />
        <StatCard label="TODAY" icon="today" value={usd(todayUsd)} note={`${use.byDay.find((d) => d.day === today)?.runs ?? 0} runs`} />
        <StatCard label="RUNS · 30D" icon="history" value={fmt.compact(runs30)} note={runs30 ? `${((failed30 / runs30) * 100).toFixed(0)}% failed or over budget` : 'no runs yet'} href="/agents/runs" />
      </div>
      {cap != null && (
        <Card title="Monthly cap" sub="When the cap is reached, running agents stop at their next step and new runs don't start until next month.">
          <span className="lc-row" style={{ gap: 14 }}>
            <Progress value={capPct} width={420} tone={capPct >= 90 ? 'red' : 'blue'} />
            <span className="lc-mono" style={{ fontSize: 13 }}>{usd(use.monthUsd)} / {usd(cap)}</span>
          </span>
        </Card>
      )}
      <Card title="Cost per day · 30 days">
        <BarChart data={days.map((d) => ({ label: d.slice(8), value: use.byDay.find((x) => x.day === d)?.costUsd ?? 0 }))} height={180} format={usdShort} />
      </Card>
      <div className="lc-grid-2">
        <Card title="Share by agent · 30 days">
          {use.byAgent.length === 0 ? (
            <span className="lc-muted" style={{ fontSize: 13 }}>No spend yet.</span>
          ) : (
            <ShareBars rows={use.byAgent.slice(0, 6).map((a) => ({ name: a.name, value: usd(a.cost), pct: total30 ? (a.cost / total30) * 100 : 0 }))} />
          )}
        </Card>
        <Card title="How budgets apply" sub="Every limit is checked before each model call, so a run stops before it overspends.">
          <span className="lc-stack" style={{ gap: 0 }}>
            <span className="lc-kv"><span>Per run</span><span className="lc-cell-sub">includes every run it delegates to</span></span>
            <span className="lc-kv"><span>Per agent per day</span><span className="lc-cell-sub">set on each agent</span></span>
            <span className="lc-kv"><span>Label per month</span><span className="lc-cell-sub">{cap != null ? usd(cap) : 'not set'}</span></span>
          </span>
        </Card>
      </div>
      <DataTable
        title="By agent · 30 days"
        rows={use.byAgent}
        rowKey={(a) => a.agentId}
        rowHref={(a) => `/agents/${a.agentId}`}
        minWidth={900}
        empty="No agent has run in the last 30 days."
        columns={[
          { key: 'n', header: 'Agent', width: 'minmax(180px,1.4fr)', render: (a) => <span className="lc-cell-strong lc-ellipsis">{a.name}</span> },
          { key: 'r', header: 'Runs', width: '80px', align: 'right', render: (a) => <span className="lc-cell-num">{a.runs}</span> },
          { key: 'f', header: 'Failed', width: '80px', align: 'right', render: (a) => <span className="lc-cell-num" style={a.failed ? { color: 'var(--lc-danger)' } : undefined}>{a.failed}</span> },
          { key: 't', header: 'Tokens in / out', width: '150px', align: 'right', render: (a) => <span className="lc-cell-num lc-muted">{fmt.compact(a.tokensIn)} / {fmt.compact(a.tokensOut)}</span> },
          { key: 'avg', header: 'Avg per run', width: '110px', align: 'right', render: (a) => <span className="lc-cell-num">{usd(a.runs ? a.cost / a.runs : 0)}</span> },
          { key: 'b', header: 'Run budget', width: '110px', align: 'right', render: (a) => <span className="lc-cell-num lc-muted">{budgets.get(a.agentId) ? usd(budgets.get(a.agentId)!.budget.perRunUsd) : '—'}</span> },
          { key: 'c', header: 'Cost', width: '100px', align: 'right', render: (a) => <span className="lc-cell-num lc-cell-strong">{usd(a.cost)}</span> },
        ]}
      />
    </Page>
  );
}
