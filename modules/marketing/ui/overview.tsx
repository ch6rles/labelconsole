import type { PageProps } from '@labelconsole/core/web';
import { listContacts } from '@labelconsole/network/service';
import { AttentionList, EmptyState, InlineNote, LinkButton, Page, PageHeader, Summary, fmt } from '@labelconsole/ui';
import { FormModal } from '@labelconsole/ui/client';
import * as svc from '../service';
import { cardFields } from './fields';

/** Marketing: what needs doing, most money first (design). */
export default async function MarketingOverviewPage({ run, session }: PageProps) {
  const canSpend = session.permissions.has('marketing:spend');
  const [o, boards, creators] = await run((ctx) => Promise.all([svc.marketingOverview(ctx), svc.listBoards(ctx), ctx.can('network:read') ? listContacts(ctx, { type: 'creator' }) : Promise.resolve([])]));
  const creatorBoards = boards.filter((b) => b.board.kind === 'creator');
  const contactOptions = creators.filter((c) => !c.goneAt && c.stage !== 'do_not_contact').map((c) => ({ value: c.id, label: c.name }));

  return (
    <Page>
      <PageHeader
        title="Marketing"
        description="What needs doing, most money first."
        actions={
          <>
            <LinkButton href="/api/v1/marketing/bookings.csv" icon="download">Full workbook CSV</LinkButton>
            {session.permissions.has('marketing:write') && creatorBoards.length > 0 && (
              <FormModal
                title="New order"
                description="Book a creator: what they'll post and what it costs. It lands on the campaign's creator board as Booked."
                trigger={{ label: 'New order', icon: 'add', variant: 'primary' }}
                endpoint="/marketing/cards"
                fields={[{ name: 'boardId', label: 'Campaign board', type: 'select', required: true, options: creatorBoards.map((b) => ({ value: b.board.id, label: b.campaignName ?? b.board.name })) }, ...cardFields(contactOptions, [{ value: 'booked', label: 'Booked' }, { value: 'offered', label: 'Offered' }, { value: 'prospect', label: 'Prospect' }], canSpend).filter((f) => !['deliverablesDelivered', 'paidCents', 'proofUrls', 'measuredViews'].includes(f.name))]}
                initial={{ stage: 'booked', deliverablesOrdered: 1, boardId: creatorBoards[0].board.id }}
                success="Order booked"
                wide
              />
            )}
          </>
        }
      />
      <Summary>
        {fmt.moneyCents(o.cashOutCents)} cash out · {o.measured} of {o.bookings} bookings measured{o.lastPaidAt ? ` · last payment ${fmt.shortDate(o.lastPaidAt)}` : ''}
      </Summary>
      <AttentionList
        wide
        rows={o.tasks.map((t) => ({ n: t.n, tone: 'accent' as const, title: t.title, sub: t.desc, href: t.href, money: t.moneyCents ? `${fmt.moneyCents(t.moneyCents)}${t.moneyLabel ? ` ${t.moneyLabel}` : ''}` : undefined }))}
        empty={
          <EmptyState icon={o.bookings === 0 ? 'campaign' : 'task_alt'} title={o.bookings === 0 ? 'No bookings yet' : 'Nothing to chase'}>
            {o.bookings === 0 ? 'Create a campaign, then book creators with New order.' : 'Every paid booking has proof, delivery matches the order, and every creator is checked.'}
          </EmptyState>
        }
      />
      {o.clear.length > 0 && o.tasks.length > 0 && <InlineNote icon="check">Clear: {o.clear.join(', ').toLowerCase()}.</InlineNote>}
      {o.mismatched > 0 && (
        <p style={{ margin: 0, fontSize: 13, color: 'var(--lc-muted)' }}>
          {o.mismatched} booking{o.mismatched === 1 ? ' carries' : 's carry'} measured views while {o.mismatched === 1 ? 'its' : 'their'} status says otherwise. Counted everywhere, since a status field cannot un-measure a measurement, but worth reconciling.
        </p>
      )}
    </Page>
  );
}
