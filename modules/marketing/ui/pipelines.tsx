import Link from 'next/link';
import type { PageProps } from '@labelconsole/core/web';
import { listContacts } from '@labelconsole/network/service';
import { DataTable, EmptyState, FilterPills, Page, PageHeader, SubTabs, Summary, fmt } from '@labelconsole/ui';
import { ActionButton, Drawer, DrawerClose, EntityForm, FormModal, Kanban } from '@labelconsole/ui/client';
import * as svc from '../service';
import { cardFields } from './fields';

const FILTER_TITLE: Record<svc.CardFilter, string> = { unproven: 'Paid bookings with no proof', short: 'Bookings delivered short', unassigned: 'Paid bookings with no campaign' };

export default async function PipelinesPage({ run, session, searchParams, path }: PageProps) {
  const filter = (['unproven', 'short', 'unassigned'] as const).find((f) => f === searchParams.filter);
  const canWrite = session.permissions.has('marketing:write');
  const canSpend = session.permissions.has('marketing:spend');
  const boards = await run((ctx) => svc.listBoards(ctx));
  const contacts = await run((ctx) => (ctx.can('network:read') ? listContacts(ctx, {}) : Promise.resolve([])));
  const contactOptions = contacts.filter((c) => !c.goneAt && c.stage !== 'do_not_contact').map((c) => ({ value: c.id, label: `${c.name} · ${c.type}` }));
  const newBoard = canWrite && (
    <FormModal title="New board" trigger={{ label: 'New board', icon: 'add' }} endpoint="/marketing/boards" fields={[{ name: 'name', label: 'Name', required: true, full: true }, { name: 'kind', label: 'Kind', type: 'select', required: true, options: [{ value: 'creator', label: 'Creator bookings' }, { value: 'editor', label: 'Editorial pitching' }, { value: 'playlist', label: 'Playlist pitching' }, { value: 'custom', label: 'Custom' }] }]} initial={{ kind: 'creator' }} columns={1} redirectTo="/marketing/pipelines?board={id}" success="Board created" />
  );

  if (filter) {
    const rows = await run((ctx) => svc.filteredBookings(ctx, filter));
    return (
      <Page>
        <PageHeader title={FILTER_TITLE[filter]} description="From the Marketing overview. Open a booking to fix it on its board." actions={<Link className="lc-btn" href="/marketing">Back to overview</Link>} />
        <Summary>{rows.length} bookings · {fmt.moneyCents(rows.reduce((a, r) => a + (r.card.paidCents ?? 0), 0))} paid</Summary>
        <DataTable
          rows={rows}
          rowKey={(r) => r.card.id}
          rowHref={(r) => `${path}?board=${r.card.boardId}&card=${r.card.id}`}
          minWidth={900}
          empty="Nothing left here."
          columns={[
            { key: 't', header: 'Booking', width: 'minmax(220px,1.4fr)', render: (r) => <span className="lc-cell-stack"><span className="lc-cell-strong lc-ellipsis">{r.card.title}</span><span className="lc-cell-sub">{r.contactName ?? 'No creator linked'}</span></span> },
            { key: 'c', header: 'Campaign', width: 'minmax(160px,1fr)', render: (r) => <span className="lc-cell-sub">{r.campaignName ?? 'Unassigned'}</span> },
            { key: 'p', header: 'Posts', width: '80px', align: 'right', render: (r) => <span className="lc-cell-num">{r.card.deliverablesDelivered}/{r.card.deliverablesOrdered}</span> },
            { key: 'paid', header: 'Paid', width: '110px', align: 'right', render: (r) => <span className="lc-cell-num">{fmt.moneyCents(r.card.paidCents ?? 0)}</span> },
            { key: 'd', header: 'Paid on', width: '100px', render: (r) => <span className="lc-mono" style={{ fontSize: 12 }}>{r.card.paidAt ? fmt.shortDate(r.card.paidAt) : '—'}</span> },
          ]}
        />
      </Page>
    );
  }

  const selectedId = searchParams.board ?? boards[0]?.board.id;
  if (!selectedId) {
    return (
      <Page>
        <PageHeader title="Pipelines" description="Kanban boards for creator bookings, editorial and playlist pitching." actions={newBoard} />
        <EmptyState icon="view_kanban" title="No boards yet" action={newBoard}>Every campaign gets a creator board automatically. You can also make boards for playlist and editorial pitching.</EmptyState>
      </Page>
    );
  }
  const d = await run((ctx) => svc.getBoard(ctx, selectedId));
  const openCard = searchParams.card ? d.cards.find((c) => c.card.id === searchParams.card) : null;
  const stageOptions = d.board.stages.map((s) => ({ value: s.id, label: s.name }));
  const paid = d.cards.reduce((a, c) => a + (c.card.paidCents ?? 0), 0);
  const boardHref = (id: string) => `${path}?board=${id}`;

  return (
    <Page>
      <PageHeader
        title="Pipelines"
        description={d.campaign ? <>Board for <Link href={`/marketing/campaigns/${d.campaign.id}`}>{d.campaign.name}</Link>. Drag cards between stages.</> : 'Drag cards between stages. Click a card to edit it.'}
        actions={
          <>
            {newBoard}
            {canWrite && <FormModal title="Add card" trigger={{ label: 'Add card', icon: 'add_card', variant: 'primary' }} endpoint="/marketing/cards" extra={{ boardId: d.board.id }} fields={cardFields(contactOptions, stageOptions, canSpend).filter((f) => !['deliverablesDelivered', 'paidCents', 'proofUrls', 'measuredViews'].includes(f.name))} initial={{ stage: d.board.stages[0].id, deliverablesOrdered: d.board.kind === 'creator' ? 1 : 0 }} success="Card added" wide />}
          </>
        }
      />
      <SubTabs items={boards.slice(0, 12).map((b) => ({ label: `${b.campaignName ? `${b.campaignName} · ` : ''}${b.board.name.replace(`${b.campaignName} · `, '')} (${b.cardCount})`, href: boardHref(b.board.id), active: b.board.id === d.board.id }))} />
      <Summary>
        {d.cards.length} cards{d.board.kind === 'creator' ? ` · ${fmt.moneyCents(paid)} paid · ${d.cards.filter((c) => (c.card.paidCents ?? 0) > 0 && c.card.proofUrls.length === 0).length} paid without proof` : ''}
      </Summary>
      <Kanban
        columns={d.board.stages}
        moveEndpoint="/marketing/cards/{id}/move"
        cards={d.cards.map((c) => ({
          id: c.card.id,
          stage: c.card.stage,
          title: c.card.title,
          sub: [c.contactName, c.card.dueDate ? `due ${fmt.shortDate(c.card.dueDate)}` : null].filter(Boolean).join(' · ') || undefined,
          meta: [
            ...(d.board.kind === 'creator' ? [`${c.card.deliverablesDelivered}/${c.card.deliverablesOrdered} posts`] : []),
            ...(c.card.paidCents ? [fmt.moneyCents(c.card.paidCents, 'USD', { decimals: 0 })] : c.card.offerCents ? [`${fmt.moneyCents(c.card.offerCents, 'USD', { decimals: 0 })} offered`] : []),
            ...(c.contactGone ? ['account gone'] : []),
          ],
          tone: c.contactGone || ((c.card.paidCents ?? 0) > 0 && c.card.proofUrls.length === 0) ? 'red' : undefined,
          href: `${path}?board=${d.board.id}&card=${c.card.id}`,
        }))}
      />
      {openCard && (
        <Drawer closeHref={boardHref(d.board.id)}>
          <div className="lc-drawer-head">
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 }}>
              <span className="lc-drawer-title">{openCard.card.title}</span>
              <span className="lc-cell-sub">{openCard.contactName ? <Link href={`/marketing/contacts/${openCard.card.contactId}`}>{openCard.contactName}</Link> : 'No contact linked'}{openCard.card.paidAt ? ` · paid ${fmt.date(openCard.card.paidAt)}` : ''}</span>
            </div>
            <DrawerClose closeHref={boardHref(d.board.id)} />
          </div>
          <div className="lc-drawer-section">
            {canWrite ? (
              <EntityForm endpoint={`/marketing/cards/${openCard.card.id}`} method="PATCH" fields={cardFields(contactOptions, stageOptions, canSpend)} initial={openCard.card as unknown as Record<string, unknown>} success="Card saved" />
            ) : (
              <p className="lc-muted">You can view this card but not edit it.</p>
            )}
            {openCard.card.proofUrls.length > 0 && (
              <div className="lc-stack" style={{ gap: 6, marginTop: 16 }}>
                <span className="lc-field-label">Proof</span>
                {openCard.card.proofUrls.map((u) => <a key={u} href={u} target="_blank" rel="noreferrer" className="lc-ellipsis" style={{ fontSize: 13 }}>{u}</a>)}
              </div>
            )}
            {canWrite && !openCard.card.paidCents && (
              <div style={{ marginTop: 20 }}>
                <ActionButton endpoint={`/marketing/cards/${openCard.card.id}`} method="DELETE" label="Delete card" icon="delete" variant="ghost" confirm="Delete this card?" redirectTo={boardHref(d.board.id)} />
              </div>
            )}
          </div>
        </Drawer>
      )}
      <FilterPills items={[{ label: 'Paid without proof', href: `${path}?filter=unproven`, active: false }, { label: 'Delivered short', href: `${path}?filter=short`, active: false }, { label: 'No campaign', href: `${path}?filter=unassigned`, active: false }]} />
    </Page>
  );
}
