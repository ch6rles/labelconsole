import type { PanelProps } from '@labelconsole/core/web';
import { DataTable, fmt } from '@labelconsole/ui';
import * as svc from '../service';
import { PITCH_LABEL, pitchChip, STATUS_LABEL, statusChip } from './fields';

/** On a release page: its campaigns and what they spent and moved. */
export async function releaseCampaignsPanel({ entityId, run }: PanelProps) {
  const rows = await run((ctx) => svc.listCampaigns(ctx, { releaseId: entityId }));
  return (
    <DataTable
      rows={rows}
      rowKey={(c) => c.id}
      rowHref={(c) => `/marketing/campaigns/${c.id}`}
      minWidth={640}
      empty="No campaigns for this release yet."
      columns={[
        { key: 'n', header: 'Campaign', width: 'minmax(200px,1fr)', render: (c) => <span className="lc-cell-strong">{c.name}</span> },
        { key: 's', header: 'Status', width: '110px', render: (c) => <span className={statusChip(c.status)}>{STATUS_LABEL[c.status]}</span> },
        { key: 'p', header: 'Spend', width: '110px', align: 'right', render: (c) => <span className="lc-cell-num">{fmt.moneyCents(c.stats.paidCents, c.currency, { decimals: 0 })}</span> },
        { key: 'v', header: 'Views', width: '90px', align: 'right', render: (c) => <span className="lc-cell-num">{c.stats.measured ? fmt.compact(c.stats.views) : '—'}</span> },
      ]}
    />
  );
}

/** On a contact page: their bookings and the pitches sent to them. */
export async function contactMarketingPanel({ entityId, run }: PanelProps) {
  const [bookings, pitchRows] = await run((ctx) => Promise.all([svc.cardsForContact(ctx, entityId), svc.listPitches(ctx, { contactId: entityId })]));
  return (
    <div className="lc-stack">
      <DataTable
        title="Bookings"
        rows={bookings}
        rowKey={(r) => r.card.id}
        rowHref={(r) => `/marketing/pipelines?board=${r.card.boardId}&card=${r.card.id}`}
        minWidth={640}
        empty="Never booked."
        columns={[
          { key: 't', header: 'Booking', width: 'minmax(200px,1fr)', render: (r) => <span className="lc-cell-stack"><span className="lc-cell-strong lc-ellipsis">{r.card.title}</span><span className="lc-cell-sub">{r.campaignName ?? r.boardName}</span></span> },
          { key: 's', header: 'Stage', width: '100px', render: (r) => <span className="lc-chip">{r.stages.find((s) => s.id === r.card.stage)?.name ?? r.card.stage}</span> },
          { key: 'po', header: 'Posts', width: '70px', align: 'right', render: (r) => <span className="lc-cell-num">{r.card.deliverablesDelivered}/{r.card.deliverablesOrdered}</span> },
          { key: 'p', header: 'Paid', width: '100px', align: 'right', render: (r) => <span className="lc-cell-num">{r.card.paidCents ? fmt.moneyCents(r.card.paidCents) : '—'}</span> },
        ]}
      />
      <DataTable
        title="Pitches"
        rows={pitchRows}
        rowKey={(r) => r.pitch.id}
        minWidth={560}
        empty="No pitches sent."
        columns={[
          { key: 's', header: 'Subject', width: 'minmax(200px,1fr)', render: (r) => <span className="lc-ellipsis">{r.pitch.subject}</span> },
          { key: 'st', header: 'Status', width: '130px', render: (r) => <span className={pitchChip(r.pitch.status)}>{PITCH_LABEL[r.pitch.status] ?? r.pitch.status}</span> },
          { key: 'd', header: 'Sent', width: '100px', render: (r) => <span className="lc-mono" style={{ fontSize: 12 }}>{r.pitch.sentAt ? fmt.shortDate(r.pitch.sentAt) : '—'}</span> },
        ]}
      />
    </div>
  );
}
