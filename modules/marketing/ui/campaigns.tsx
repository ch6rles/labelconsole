import type { PageProps } from '@labelconsole/core/web';
import { listReleases } from '@labelconsole/catalogue/service';
import { DataTable, FilterPills, Page, PageHeader, Progress, Summary, fmt, type Column } from '@labelconsole/ui';
import { FormModal, SearchInput } from '@labelconsole/ui/client';
import { CAMPAIGN_STATUSES } from '../schema';
import * as svc from '../service';
import { campaignFields, STATUS_LABEL, statusChip } from './fields';

type Row = Awaited<ReturnType<typeof svc.listCampaigns>>[number];

export default async function CampaignsPage({ run, session, searchParams, path }: PageProps) {
  const status = CAMPAIGN_STATUSES.find((s) => s === searchParams.status);
  const [rows, all, releases] = await run((ctx) => Promise.all([svc.listCampaigns(ctx, { status, q: searchParams.q }), svc.listCampaigns(ctx, {}), ctx.can('catalogue:read') ? listReleases(ctx, {}) : Promise.resolve([])]));
  const n = (s?: string) => all.filter((c) => !s || c.status === s).length;
  const spent = all.reduce((a, c) => a + c.stats.paidCents, 0);
  const budget = all.filter((c) => c.status === 'active' || c.status === 'planning').reduce((a, c) => a + c.budgetCents, 0);

  const columns: Column<Row>[] = [
    { key: 'name', header: 'Campaign', width: 'minmax(220px,1.5fr)', render: (c) => <span className="lc-cell-stack"><span className="lc-cell-strong lc-ellipsis">{c.name}</span><span className="lc-cell-sub lc-ellipsis">{c.releaseTitle ?? 'No release linked'}</span></span> },
    { key: 'status', header: 'Status', width: '110px', render: (c) => <span className={statusChip(c.status)}>{STATUS_LABEL[c.status]}</span> },
    { key: 'dates', header: 'Dates', width: '150px', render: (c) => <span className="lc-mono" style={{ fontSize: 12, color: 'var(--lc-text-2)' }}>{c.startDate ? fmt.shortDate(c.startDate) : 'TBD'} → {c.endDate ? fmt.shortDate(c.endDate) : 'open'}</span> },
    {
      key: 'spend',
      header: 'Spend / budget',
      width: '190px',
      render: (c) => (
        <span className="lc-row" style={{ gap: 10, flexWrap: 'nowrap' }}>
          <Progress value={c.budgetCents ? Math.min(100, (c.stats.paidCents / c.budgetCents) * 100) : 0} tone={c.budgetCents && c.stats.paidCents > c.budgetCents ? 'red' : 'blue'} />
          <span className="lc-mono" style={{ fontSize: 12 }}>{fmt.moneyCents(c.stats.paidCents, c.currency, { decimals: 0 })} / {c.budgetCents ? fmt.moneyCents(c.budgetCents, c.currency, { decimals: 0 }) : '—'}</span>
        </span>
      ),
    },
    { key: 'bookings', header: 'Bookings', width: '80px', align: 'right', render: (c) => <span className="lc-cell-num">{c.stats.bookings}</span> },
    { key: 'posts', header: 'Posts', width: '80px', align: 'right', render: (c) => <span className="lc-cell-num" style={{ color: c.stats.delivered < c.stats.ordered ? 'var(--lc-danger)' : undefined }}>{c.stats.delivered}/{c.stats.ordered}</span> },
    { key: 'views', header: 'Views', width: '90px', align: 'right', render: (c) => <span className="lc-cell-num">{c.stats.measured ? fmt.compact(c.stats.views) : '—'}</span> },
    { key: 'cpm', header: '$ / 1k', width: '80px', align: 'right', render: (c) => <span className="lc-cell-num">{c.stats.costPer1kCents != null ? fmt.moneyCents(c.stats.costPer1kCents, c.currency) : '—'}</span> },
    { key: 'outreach', header: 'Outreach', width: '100px', align: 'right', render: (c) => <span className="lc-cell-num lc-muted">{c.stats.pitchesSent ? `${c.stats.accepted}/${c.stats.pitchesSent}` : '—'}</span> },
  ];

  return (
    <Page>
      <PageHeader
        title="Campaigns"
        description="Each campaign ties a release to its budget, KPIs, creator bookings and playlist outreach, and measures the stream lift."
        actions={session.permissions.has('marketing:write') && <FormModal title="New campaign" trigger={{ label: 'New campaign', icon: 'add', variant: 'primary' }} endpoint="/marketing/campaigns" fields={campaignFields(releases.map((r) => ({ value: r.id, label: r.title })))} initial={{ status: 'planning', currency: 'USD', kpis: [] }} redirectTo="/marketing/campaigns/{id}" success="Campaign created" wide />}
      />
      <Summary>
        {n('active')} active · {n('planning')} in planning · {fmt.moneyCents(spent)} spent across all campaigns · {fmt.moneyCents(budget)} budgeted for open ones
      </Summary>
      <div className="lc-toolbar">
        <FilterPills items={[{ label: 'All', count: n(), href: path, active: !status }, ...CAMPAIGN_STATUSES.filter((s) => n(s) > 0).map((s) => ({ label: STATUS_LABEL[s], count: n(s), href: `${path}?status=${s}`, active: status === s }))]} />
        <SearchInput placeholder="Search campaigns" />
      </div>
      <DataTable rows={rows} rowKey={(c) => c.id} rowHref={(c) => `/marketing/campaigns/${c.id}`} columns={columns} minWidth={1120} empty={status || searchParams.q ? 'No campaigns match.' : 'No campaigns yet. Start one for your next release.'} />
    </Page>
  );
}
