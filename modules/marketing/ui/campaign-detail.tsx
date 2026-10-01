import Link from 'next/link';
import type { PageProps } from '@labelconsole/core/web';
import { listReleases } from '@labelconsole/catalogue/service';
import { Card, DataTable, EmptyState, Icon, KV, LineChart, Page, PageHeader, Progress, StatCard, fmt } from '@labelconsole/ui';
import { ActionButton, FormModal } from '@labelconsole/ui/client';
import * as svc from '../service';
import { campaignFields, pitchChip, PITCH_LABEL, STATUS_LABEL, statusChip } from './fields';

export default async function CampaignDetailPage({ run, params, session, panels }: PageProps) {
  const [d, releases] = await run((ctx) => Promise.all([svc.getCampaign(ctx, params.id), ctx.can('catalogue:read') ? listReleases(ctx, {}) : Promise.resolve([])]));
  const c = d.campaign;
  const s = d.stats;
  const canWrite = session.permissions.has('marketing:write');
  const delta = d.streamDelta;
  const rendered = await Promise.all(panels('campaign').map(async (p) => ({ id: p.id, title: p.title, node: await p.component({ entityId: c.id, run, session }) })));
  const nextStatus = c.status === 'planning' || c.status === 'paused' ? { to: 'active', label: c.status === 'paused' ? 'Resume' : 'Start campaign', icon: 'play_arrow' } : c.status === 'active' ? { to: 'paused', label: 'Pause', icon: 'pause' } : null;

  return (
    <Page>
      <PageHeader
        title={
          <span className="lc-row" style={{ gap: 12 }}>
            {c.name}
            <span className={statusChip(c.status)}>{STATUS_LABEL[c.status]}</span>
          </span>
        }
        description={`${d.release ? d.release.title : 'No release linked'} · ${c.startDate ? fmt.date(c.startDate) : 'start TBD'} → ${c.endDate ? fmt.date(c.endDate) : 'open-ended'}`}
        actions={
          canWrite && (
            <>
              {nextStatus && <ActionButton endpoint={`/marketing/campaigns/${c.id}`} method="PATCH" body={{ status: nextStatus.to }} label={nextStatus.label} icon={nextStatus.icon} success="Campaign updated" />}
              {c.status === 'active' && <ActionButton endpoint={`/marketing/campaigns/${c.id}`} method="PATCH" body={{ status: 'completed' }} label="Complete" icon="flag" variant="ghost" confirm="Mark this campaign completed?" />}
              <FormModal title={`Edit ${c.name}`} trigger={{ label: 'Edit', icon: 'edit', variant: 'primary' }} endpoint={`/marketing/campaigns/${c.id}`} method="PATCH" fields={campaignFields(releases.map((r) => ({ value: r.id, label: r.title })))} initial={c as unknown as Record<string, unknown>} wide />
            </>
          )
        }
      />
      <div className="lc-grid-stats">
        <StatCard label="SPEND" icon="payments" value={fmt.moneyCents(s.paidCents, c.currency)} note={c.budgetCents ? `of ${fmt.moneyCents(c.budgetCents, c.currency)} budget · ${fmt.moneyCents(s.offerCents, c.currency)} offered` : 'no budget set'} />
        <StatCard label="BOOKINGS" icon="handshake" value={String(s.bookings)} note={`${s.delivered} of ${s.ordered} posts delivered${s.unproven ? ` · ${s.unproven} paid without proof` : ''}`} />
        <StatCard label="MEASURED VIEWS" icon="visibility" value={s.measured ? fmt.compact(s.views) : '—'} note={s.costPer1kCents != null ? `${fmt.moneyCents(s.costPer1kCents, c.currency)} per 1,000 views` : 'no views measured yet'} />
        <StatCard
          label="STREAM DELTA"
          icon="trending_up"
          value={delta ? fmt.compact(delta.change, { signed: true }) : '—'}
          delta={delta?.changePct != null ? fmt.pct(delta.changePct, { signed: true }) : undefined}
          deltaDown={(delta?.change ?? 0) < 0}
          note={delta ? `${fmt.compact(delta.during)} plays in ${delta.days} days vs ${fmt.compact(delta.before)} before` : d.release ? 'starts counting from the start date' : 'link a release to measure'}
        />
      </div>

      <div className="lc-grid-2">
        <Card title="KPIs" sub="Streams come from the tracker, views and posts from bookings, adds from accepted pitches.">
          {d.kpis.length === 0 && <span className="lc-muted" style={{ fontSize: 13 }}>No KPIs set. Add them with Edit.</span>}
          {d.kpis.map((k) => (
            <div key={k.name} className="lc-kv">
              <span className="lc-cell-stack">
                <span>{k.name}</span>
                <span className="lc-cell-sub">{k.metric === 'custom' ? 'entered by hand' : `measured: ${k.metric}`}</span>
              </span>
              <span className="lc-row" style={{ gap: 10, flexWrap: 'nowrap' }}>
                <Progress value={k.progress ?? 0} width={80} tone={(k.progress ?? 0) >= 100 ? 'blue' : 'wait'} />
                <span className="lc-mono" style={{ fontSize: 12, whiteSpace: 'nowrap' }}>{k.measured != null ? fmt.compact(k.measured) : '—'} / {fmt.compact(k.target)} {k.unit}</span>
              </span>
            </div>
          ))}
          {c.goals && <p style={{ fontSize: 13, color: 'var(--lc-text-2)', whiteSpace: 'pre-wrap', margin: '12px 0 0' }}>{c.goals}</p>}
        </Card>
        <Card title="Plays on the release" sub={delta ? `${delta.trackCount} track${delta.trackCount === 1 ? '' : 's'}, polled sources, from before the start until today` : undefined}>
          {delta && delta.daily.length > 1 ? (
            <LineChart series={[{ name: 'Plays per day', points: delta.daily.map((p) => ({ x: p.day, y: p.plays })) }]} height={180} />
          ) : (
            <EmptyState icon="monitoring" title="No stream readings yet">{d.release ? 'Plays show here once the release’s tracks have YouTube matches and readings.' : 'Link a release to this campaign.'}</EmptyState>
          )}
        </Card>
      </div>

      <DataTable
        title="Bookings and pipeline cards"
        rows={d.cards}
        rowKey={(r) => r.card.id}
        rowHref={(r) => `/marketing/pipelines?board=${r.card.boardId}&card=${r.card.id}`}
        minWidth={900}
        empty="Nothing booked yet."
        columns={[
          { key: 't', header: 'Card', width: 'minmax(200px,1.4fr)', render: (r) => <span className="lc-cell-stack"><span className="lc-cell-strong lc-ellipsis">{r.card.title}</span><span className="lc-cell-sub">{r.boardName}</span></span> },
          { key: 's', header: 'Stage', width: '110px', render: (r) => <span className="lc-chip">{d.boards.find((b) => b.id === r.card.boardId)?.stages.find((x) => x.id === r.card.stage)?.name ?? r.card.stage}</span> },
          { key: 'p', header: 'Posts', width: '80px', align: 'right', render: (r) => <span className="lc-cell-num">{r.boardKind === 'creator' ? `${r.card.deliverablesDelivered}/${r.card.deliverablesOrdered}` : '—'}</span> },
          { key: 'paid', header: 'Paid', width: '110px', align: 'right', render: (r) => <span className="lc-cell-num">{r.card.paidCents ? fmt.moneyCents(r.card.paidCents, c.currency) : r.card.offerCents ? <span className="lc-muted">{fmt.moneyCents(r.card.offerCents, c.currency)} offered</span> : '—'}</span> },
          { key: 'proof', header: 'Proof', width: '80px', render: (r) => (r.card.proofUrls.length ? <span className="lc-chip lc-chip--outline-blue">{r.card.proofUrls.length} link{r.card.proofUrls.length === 1 ? '' : 's'}</span> : r.card.paidCents ? <span className="lc-chip lc-chip--red">Missing</span> : <span className="lc-muted">—</span>) },
          { key: 'v', header: 'Views', width: '90px', align: 'right', render: (r) => <span className="lc-cell-num">{r.card.measuredViews != null ? fmt.compact(r.card.measuredViews) : '—'}</span> },
        ]}
      />

      <DataTable
        title="Outreach"
        rows={d.pitches}
        rowKey={(p) => p.id}
        minWidth={700}
        empty={<span>No pitches yet. Draft them under <Link href="/marketing/outreach">Outreach</Link>.</span>}
        columns={[
          { key: 's', header: 'Subject', width: 'minmax(220px,1fr)', render: (p) => <span className="lc-cell-strong lc-ellipsis">{p.subject}</span> },
          { key: 'st', header: 'Status', width: '130px', render: (p) => <span className={pitchChip(p.status)}>{PITCH_LABEL[p.status] ?? p.status}</span> },
          { key: 'd', header: 'Sent', width: '120px', render: (p) => <span className="lc-mono" style={{ fontSize: 12 }}>{p.sentAt ? fmt.shortDate(p.sentAt) : '—'}</span> },
        ]}
      />

      <div className="lc-grid-2">
        <Card
          title="Boards"
          actions={canWrite && <FormModal title="New board" trigger={{ label: 'New board', icon: 'add', size: 'sm' }} endpoint="/marketing/boards" fields={[{ name: 'name', label: 'Name', required: true, full: true }, { name: 'kind', label: 'Kind', type: 'select', required: true, options: [{ value: 'creator', label: 'Creator bookings' }, { value: 'editor', label: 'Editorial pitching' }, { value: 'playlist', label: 'Playlist pitching' }, { value: 'custom', label: 'Custom' }] }]} extra={{ campaignId: c.id }} initial={{ kind: 'playlist' }} columns={1} redirectTo="/marketing/pipelines?board={id}" success="Board created" />}
        >
          {d.boards.map((b) => <KV key={b.id} k={<Link href={`/marketing/pipelines?board=${b.id}`}>{b.name}</Link>} v={<span className="lc-muted" style={{ fontSize: 12 }}>{fmt.titleCase(b.kind)} · {d.cards.filter((x) => x.card.boardId === b.id).length} cards</span>} />)}
        </Card>
        <Card title="Sketchboards" actions={canWrite && <FormModal title="New sketchboard" trigger={{ label: 'New sketchboard', icon: 'add', size: 'sm' }} endpoint="/marketing/sketchboards" fields={[{ name: 'name', label: 'Name', required: true, full: true }]} extra={{ campaignId: c.id }} columns={1} redirectTo="/marketing/sketchboards/{id}" success="Sketchboard created" />}>
          {d.sketchboards.length === 0 && <span className="lc-muted" style={{ fontSize: 13 }}>None yet. Sketch the rollout: notes, references and the timeline.</span>}
          {d.sketchboards.map((b) => <KV key={b.id} k={<Link href={`/marketing/sketchboards/${b.id}`}>{b.name}</Link>} v={<span className="lc-mono" style={{ fontSize: 12 }}>{fmt.relative(b.updatedAt)}</span>} />)}
        </Card>
      </div>
      {rendered.map((p) => (
        <section key={p.id} className="lc-section">
          <h2 className="lc-h2" style={{ fontSize: 17 }}>{p.title}</h2>
          {p.node}
        </section>
      ))}
      {session.permissions.has('marketing:delete') && <div><ActionButton endpoint={`/marketing/campaigns/${c.id}`} method="DELETE" label="Delete campaign" icon="delete" variant="ghost" confirm={`Delete ${c.name}? Boards and sketchboards go with it.`} redirectTo="/marketing/campaigns" /></div>}
      <Link href="/marketing/campaigns" className="lc-btn lc-btn--link"><Icon name="arrow_back" />All campaigns</Link>
    </Page>
  );
}
