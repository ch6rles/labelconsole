import { and, desc, eq, sql } from 'drizzle-orm';
import type { ServiceContext } from '@labelconsole/core/context';
import { contacts } from '@labelconsole/network/schema';
import { boards, campaigns, cards } from '../schema';
import { cardCampaign, isBooking } from './shared';

export type MarketingTask = { key: string; n: number; moneyCents: number; moneyLabel: 'paid' | 'at stake' | null; title: string; desc: string; href: string };

const paid = sql`coalesce(${cards.paidCents}, 0) > 0`;
const noProof = sql`cardinality(${cards.proofUrls}) = 0`;

/**
 * The Marketing overview: what needs doing, most money first. Everything is
 * computed from the booking ledger (cards on creator boards) and the creator
 * network, so the numbers can always be traced back to rows.
 */
export async function marketingOverview(ctx: ServiceContext) {
  ctx.assert('marketing:read');
  const [ledger] = await ctx.tx
    .select({
      bookings: sql<number>`count(*)::int`,
      cashOutCents: sql<number>`coalesce(sum(${cards.paidCents}), 0)::bigint`,
      measured: sql<number>`count(*) filter (where ${cards.measuredViews} is not null)::int`,
      lastPaidAt: sql<string | null>`max(${cards.paidAt})::text`,
      unprovenN: sql<number>`count(*) filter (where ${paid} and ${noProof})::int`,
      unprovenCents: sql<number>`coalesce(sum(${cards.paidCents}) filter (where ${paid} and ${noProof}), 0)::bigint`,
      unprovenCampaigns: sql<number>`count(distinct ${cardCampaign}) filter (where ${paid} and ${noProof})::int`,
      shortN: sql<number>`count(*) filter (where ${cards.deliverablesDelivered} < ${cards.deliverablesOrdered} and not ${noProof})::int`,
      shortCents: sql<number>`coalesce(sum(${cards.paidCents}) filter (where ${cards.deliverablesDelivered} < ${cards.deliverablesOrdered} and not ${noProof}), 0)::bigint`,
      unassignedN: sql<number>`count(*) filter (where ${paid} and ${cardCampaign} is null)::int`,
      unassignedCents: sql<number>`coalesce(sum(${cards.paidCents}) filter (where ${paid} and ${cardCampaign} is null), 0)::bigint`,
      mismatched: sql<number>`count(*) filter (where ${cards.measuredViews} is not null and ${cards.stage} not in ('posted', 'paid'))::int`,
      views: sql<number>`coalesce(sum(${cards.measuredViews}), 0)::bigint`,
    })
    .from(cards)
    .innerJoin(boards, eq(boards.id, cards.boardId))
    .where(isBooking);

  // Creator accounts and what has been paid to each kind.
  const [people] = await ctx.tx
    .select({
      unverifiedN: sql<number>`count(*) filter (where ${contacts.verifiedAt} is null and ${contacts.goneAt} is null)::int`,
      unverifiedPaid: sql<number>`coalesce(sum(p.paid) filter (where ${contacts.verifiedAt} is null and ${contacts.goneAt} is null), 0)::bigint`,
      noPayoutN: sql<number>`count(*) filter (where ${contacts.payoutEmail} is null and ${contacts.goneAt} is null)::int`,
      noPayoutBooked: sql<number>`count(*) filter (where ${contacts.payoutEmail} is null and ${contacts.goneAt} is null and p.bookings > 0)::int`,
      goneN: sql<number>`count(*) filter (where ${contacts.goneAt} is not null)::int`,
      gonePaid: sql<number>`coalesce(sum(p.paid) filter (where ${contacts.goneAt} is not null), 0)::bigint`,
    })
    .from(contacts)
    .leftJoin(
      sql`(select c.contact_id, sum(coalesce(c.paid_cents, 0)) as paid, count(*) as bookings from pipeline_cards c join pipeline_boards b on b.id = c.board_id where b.kind = 'creator' group by c.contact_id) p`,
      sql`p.contact_id = ${contacts.id}`,
    )
    .where(eq(contacts.type, 'creator'));

  const n = (v: unknown) => Number(v ?? 0);
  const tasks: MarketingTask[] = [
    {
      key: 'proof',
      n: n(ledger.unprovenN),
      moneyCents: n(ledger.unprovenCents),
      moneyLabel: null,
      title: 'Link the proof for paid bookings',
      desc: `Paid, with no post on file. Most were delivered and never linked, and this is what makes every view count and $/1k trustworthy.${n(ledger.unprovenCampaigns) ? ` Across ${n(ledger.unprovenCampaigns)} campaign${n(ledger.unprovenCampaigns) === 1 ? '' : 's'}.` : ''}`,
      href: '/marketing/pipelines?filter=unproven',
    },
    { key: 'short', n: n(ledger.shortN), moneyCents: n(ledger.shortCents), moneyLabel: null, title: 'Chase bookings delivered short', desc: 'Fewer posts than were ordered, but proof is on file, so these are partial, not just unlinked.', href: '/marketing/pipelines?filter=short' },
    { key: 'unverified', n: n(people.unverifiedN), moneyCents: n(people.unverifiedPaid), moneyLabel: 'paid', title: 'Check creator accounts nobody has verified', desc: 'Never account-checked, which is not the same as gone. Verify before booking them again.', href: '/marketing/contacts?type=creator&account=unverified' },
    { key: 'payout', n: n(people.noPayoutN), moneyCents: 0, moneyLabel: null, title: 'Add a payout address', desc: `Creators with no payout address on file.${n(people.noPayoutBooked) ? ` ${n(people.noPayoutBooked)} of them already booked, so they cannot be paid until one is.` : ''}`, href: '/marketing/contacts?type=creator&account=no_payout' },
    { key: 'unassigned', n: n(ledger.unassignedN), moneyCents: n(ledger.unassignedCents), moneyLabel: null, title: 'Attribute the unassigned ledger rows', desc: 'Paid bookings with no campaign attached. They count in the total above and in no campaign’s figures.', href: '/marketing/pipelines?filter=unassigned' },
    { key: 'gone', n: n(people.goneN), moneyCents: n(people.gonePaid), moneyLabel: 'paid', title: 'Accounts confirmed gone', desc: 'The account no longer exists. Kept visible so past spend stays auditable. Nothing to do, but do not re-book them.', href: '/marketing/contacts?account=gone' },
  ];
  const [active] = await ctx.tx.select({ n: sql<number>`count(*)::int` }).from(campaigns).where(eq(campaigns.status, 'active'));
  return {
    cashOutCents: n(ledger.cashOutCents),
    bookings: n(ledger.bookings),
    measured: n(ledger.measured),
    lastPaidAt: ledger.lastPaidAt,
    views: n(ledger.views),
    mismatched: n(ledger.mismatched),
    activeCampaigns: active?.n ?? 0,
    tasks: tasks.filter((t) => t.n > 0).sort((a, b) => b.moneyCents - a.moneyCents || b.n - a.n),
    clear: tasks.filter((t) => t.n === 0).map((t) => t.title),
  };
}

/** Booking filters behind the overview's links. */
export type CardFilter = 'unproven' | 'short' | 'unassigned';

export async function filteredBookings(ctx: ServiceContext, filter: CardFilter) {
  ctx.assert('marketing:read');
  const cond = filter === 'unproven' ? and(paid, noProof) : filter === 'short' ? and(sql`${cards.deliverablesDelivered} < ${cards.deliverablesOrdered}`, sql`not ${noProof}`) : and(paid, sql`${cardCampaign} is null`);
  return ctx.tx
    .select({ card: cards, boardName: boards.name, contactName: contacts.name, campaignName: campaigns.name })
    .from(cards)
    .innerJoin(boards, eq(boards.id, cards.boardId))
    .leftJoin(contacts, eq(contacts.id, cards.contactId))
    .leftJoin(campaigns, eq(campaigns.id, cardCampaign))
    .where(and(isBooking, cond))
    .orderBy(desc(cards.paidCents))
    .limit(500);
}

/** The whole booking ledger as CSV (the design's "Full workbook CSV"). */
export async function bookingsCsv(ctx: ServiceContext) {
  ctx.assert('marketing:read');
  const rows = await ctx.tx
    .select({ card: cards, board: boards.name, kind: boards.kind, contact: contacts.name, contactEmail: contacts.email, campaign: campaigns.name })
    .from(cards)
    .innerJoin(boards, eq(boards.id, cards.boardId))
    .leftJoin(contacts, eq(contacts.id, cards.contactId))
    .leftJoin(campaigns, eq(campaigns.id, cardCampaign))
    .orderBy(desc(cards.createdAt))
    .limit(100_000);
  const showMoney = ctx.can('marketing:spend') || ctx.can('documents:read_financial');
  const esc = (v: unknown) => {
    const s = v == null ? '' : v instanceof Date ? v.toISOString() : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const header = ['created', 'campaign', 'board', 'board_kind', 'stage', 'title', 'contact', 'contact_email', 'offer', 'paid', 'paid_at', 'ordered', 'delivered', 'proof_urls', 'measured_views', 'notes'];
  const lines = rows.map((r) =>
    [r.card.createdAt, r.campaign, r.board, r.kind, r.card.stage, r.card.title, r.contact, r.contactEmail, showMoney && r.card.offerCents != null ? (r.card.offerCents / 100).toFixed(2) : '', showMoney && r.card.paidCents != null ? (r.card.paidCents / 100).toFixed(2) : '', r.card.paidAt, r.card.deliverablesOrdered, r.card.deliverablesDelivered, r.card.proofUrls.join(' '), r.card.measuredViews, r.card.notes].map(esc).join(','),
  );
  return [header.join(','), ...lines].join('\n') + '\n';
}
