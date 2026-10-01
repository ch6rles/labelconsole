import Link from 'next/link';
import type { PageProps } from '@labelconsole/core/web';
import { listTracks } from '@labelconsole/catalogue/service';
import { listContacts, listPlaylists } from '@labelconsole/network/service';
import { DataTable, FilterPills, Page, PageHeader, Summary, fmt, type Column } from '@labelconsole/ui';
import { ActionButton, FormModal } from '@labelconsole/ui/client';
import { PITCH_STATUSES } from '../schema';
import * as svc from '../service';
import { PITCH_LABEL, pitchChip, pitchFields } from './fields';

type Row = Awaited<ReturnType<typeof svc.listPitches>>[number];

/** The playlist and editor outreach tracker. */
export default async function OutreachPage({ run, session, searchParams, path }: PageProps) {
  const status = PITCH_STATUSES.find((s) => s === searchParams.status);
  const canWrite = session.permissions.has('marketing:write');
  const [rows, all, contacts, campaigns, lists, trackRows] = await run((ctx) =>
    Promise.all([
      svc.listPitches(ctx, { status, campaignId: searchParams.campaign }),
      svc.listPitches(ctx, {}),
      ctx.can('network:read') ? listContacts(ctx, {}) : Promise.resolve([]),
      svc.listCampaigns(ctx, {}),
      ctx.can('network:read') ? listPlaylists(ctx, {}) : Promise.resolve([]),
      ctx.can('catalogue:read') ? listTracks(ctx, {}) : Promise.resolve([]),
    ]),
  );
  const options = {
    contacts: contacts.filter((c) => !c.goneAt && c.stage !== 'do_not_contact').map((c) => ({ value: c.id, label: `${c.name}${c.email ? '' : ' (no email)'}` })),
    campaigns: campaigns.filter((c) => c.status !== 'cancelled' && c.status !== 'completed').map((c) => ({ value: c.id, label: c.name })),
    playlists: lists.map((p) => ({ value: p.playlist.id, label: `${p.playlist.name}${p.curator ? ` · ${p.curator}` : ''}` })),
    tracks: trackRows.map((t) => ({ value: t.id, label: t.title })),
  };
  const n = (s?: string) => all.filter((p) => !s || p.pitch.status === s).length;
  const sent = all.filter((p) => p.pitch.sentAt).length;
  const responded = all.filter((p) => ['replied', 'accepted', 'declined'].includes(p.pitch.status)).length;

  const columns: Column<Row>[] = [
    { key: 'to', header: 'To', width: 'minmax(180px,1fr)', render: (r) => <span className="lc-cell-stack"><Link href={`/marketing/contacts/${r.pitch.contactId}`} className="lc-cell-strong" style={{ color: 'var(--lc-ink)' }}>{r.contactName}</Link><span className="lc-cell-sub">{r.playlistName ? `${r.playlistName}${r.playlistFollowers != null ? ` · ${fmt.compact(r.playlistFollowers)}` : ''}` : r.contactType}</span></span> },
    { key: 'subject', header: 'Pitch', width: 'minmax(240px,1.6fr)', render: (r) => <span className="lc-cell-stack"><span className="lc-ellipsis" style={{ fontSize: 14 }}>{r.pitch.subject}</span><span className="lc-cell-sub lc-ellipsis">{[r.trackTitle, r.campaignName].filter(Boolean).join(' · ') || '—'}{r.pitch.agentRunId ? ' · drafted by an agent' : ''}</span></span> },
    { key: 'status', header: 'Status', width: '140px', render: (r) => <span className="lc-cell-stack" style={{ alignItems: 'flex-start' }}><span className={pitchChip(r.pitch.status)}>{PITCH_LABEL[r.pitch.status] ?? r.pitch.status}</span>{r.pitch.outcome && <span className="lc-cell-sub lc-ellipsis" title={r.pitch.outcome}>{r.pitch.outcome}</span>}</span> },
    { key: 'sent', header: 'Sent', width: '100px', render: (r) => <span className="lc-mono" style={{ fontSize: 12 }}>{r.pitch.sentAt ? fmt.shortDate(r.pitch.sentAt) : '—'}</span> },
    {
      key: 'actions',
      header: '',
      width: '260px',
      align: 'right',
      render: (r) =>
        !canWrite ? null : (
          <span className="lc-row" style={{ gap: 6, justifyContent: 'flex-end', flexWrap: 'nowrap' }}>
            {(r.pitch.status === 'draft' || (r.pitch.status === 'approved' && r.pitch.outcome)) && (
              <>
                <FormModal title="Edit pitch" trigger={{ label: 'Edit', size: 'sm', variant: 'ghost' }} endpoint={`/marketing/pitches/${r.pitch.id}`} method="PATCH" fields={pitchFields(options).filter((f) => f.name !== 'contactId')} initial={r.pitch as unknown as Record<string, unknown>} wide />
                <ActionButton endpoint={`/marketing/pitches/${r.pitch.id}/send`} label="Send" icon="send" size="sm" variant="primary" confirm={`Send "${r.pitch.subject}" to ${r.contactName}${r.contactEmail ? ` <${r.contactEmail}>` : ''}?`} success="Sending" />
              </>
            )}
            {r.pitch.sentAt && !['accepted', 'declined'].includes(r.pitch.status) && (
              <FormModal title={`Response from ${r.contactName}`} trigger={{ label: 'Record response', size: 'sm' }} endpoint={`/marketing/pitches/${r.pitch.id}/outcome`} fields={[{ name: 'status', label: 'What happened', type: 'select', required: true, options: [{ value: 'opened', label: 'Opened' }, { value: 'replied', label: 'Replied' }, { value: 'accepted', label: 'Accepted / added' }, { value: 'declined', label: 'Declined' }] }, { name: 'outcome', label: 'Note', type: 'textarea' }]} initial={{ status: 'replied' }} columns={1} />
            )}
            {!r.pitch.sentAt && r.pitch.status === 'draft' && <ActionButton iconOnly icon="delete" title="Delete draft" variant="danger" endpoint={`/marketing/pitches/${r.pitch.id}`} method="DELETE" confirm="Delete this draft?" />}
          </span>
        ),
    },
  ];

  return (
    <Page>
      <PageHeader
        title="Outreach"
        description="Pitches to playlist editors, curators, creators and press. Sent from the label mailbox; replies and adds are tracked here and in each contact's history."
        actions={canWrite && <FormModal title="New pitch" trigger={{ label: 'New pitch', icon: 'edit_note', variant: 'primary' }} endpoint="/marketing/pitches" fields={pitchFields(options)} success="Draft saved" wide />}
      />
      <Summary>
        {n('draft')} drafts · {sent} sent · {responded} responses ({sent ? Math.round((responded / sent) * 100) : 0}%) · {n('accepted')} accepted
      </Summary>
      <FilterPills items={[{ label: 'All', count: n(), href: path, active: !status }, ...PITCH_STATUSES.filter((s) => n(s) > 0).map((s) => ({ label: PITCH_LABEL[s], count: n(s), href: `${path}?status=${s}`, active: status === s }))]} />
      <DataTable rows={rows} rowKey={(r) => r.pitch.id} columns={columns} minWidth={1060} empty={status ? 'No pitches with that status.' : 'No pitches yet. Draft one, or let the Playlist Outreach agent draft them for you to approve.'} />
    </Page>
  );
}
