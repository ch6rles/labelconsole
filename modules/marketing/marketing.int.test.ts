import { and, eq } from 'drizzle-orm';
import { afterAll, describe, expect, it, vi } from 'vitest';
import '../../test/modules';
import { closeDb, systemDb } from '@labelconsole/core/db/client';
import { domainEvents } from '@labelconsole/core/db/schema';
import { ConflictError, ForbiddenError, ValidationError } from '@labelconsole/core/errors';
import { PermissionSet } from '@labelconsole/core/permissions';
import { closeQueues } from '@labelconsole/core/queue';
import { closeRedis } from '@labelconsole/core/redis';
import { createRelease, createTrack } from '@labelconsole/catalogue/service';
import { createContact, getContact, logInteraction, contactForAgent } from '@labelconsole/network/service';
import { createArtist } from '@labelconsole/people/service';
import { recordSnapshots } from '@labelconsole/streams/service';
import { makeOrg, runJob } from '../../test/helpers';
import { jobs } from './jobs';
import { pitches } from './schema';
import * as svc from './service';

const sent: Array<{ to: string; subject: string }> = [];
// SMTP stand-in with the same error contract as the real sendMail.
vi.mock('@labelconsole/core/mail', async () => {
  const { ProviderError } = await vi.importActual<typeof import('@labelconsole/core/errors')>('@labelconsole/core/errors');
  return {
    sendMail: vi.fn(async (_ctx: unknown, msg: { to: string; subject: string }) => {
      if (msg.to === 'down@example.test') throw new ProviderError('smtp', 'SMTP 421 try later', { transient: true, status: 421 });
      sent.push(msg);
      return { messageId: `<${sent.length}@test>` };
    }),
  };
});

afterAll(async () => {
  await closeQueues();
  await closeDb();
  await closeRedis();
});

const DAY = 86400_000;
const day = (n: number) => new Date(Date.now() + n * DAY).toISOString().slice(0, 10);

describe('network', () => {
  it('dedupes contacts by email and normalised handle, and moves the relationship along', async () => {
    const a = await makeOrg();
    const c = await a.as((ctx) => createContact(ctx, { type: 'creator', name: 'Ola Hart', handles: { tiktok: '@OlaHart' }, audienceSize: 240_000, genres: ['indie'], payoutEmail: 'pay@ola.test' }));
    expect(c.handles).toEqual({ tiktok: 'olahart' });
    await expect(a.as((ctx) => createContact(ctx, { type: 'creator', name: 'Ola H.', handles: { tiktok: 'https://www.tiktok.com/@olahart' } }))).rejects.toBeInstanceOf(ConflictError);
    await a.as((ctx) => logInteraction(ctx, c.id, { channel: 'dm', summary: 'Asked about rates' }));
    expect((await a.as((ctx) => getContact(ctx, c.id))).contact.stage).toBe('contacted');
    await a.as((ctx) => logInteraction(ctx, c.id, { channel: 'dm', direction: 'inbound', summary: '$300 per post' }));
    const d = await a.as((ctx) => getContact(ctx, c.id));
    expect(d.contact.stage).toBe('engaged');
    expect(d.interactions).toHaveLength(2);
    // Agents never see payout details.
    expect(JSON.stringify(contactForAgent(d.contact))).not.toContain('pay@ola.test');
  });
});

describe('marketing', () => {
  it('ties a campaign to a release, bookings and stream deltas', async () => {
    const a = await makeOrg();
    const { campaign, track, creator } = await a.as(async (ctx) => {
      const artist = await createArtist(ctx, { name: 'Juno Vale', status: 'active' });
      const release = await createRelease(ctx, { title: 'Night Ferries', type: 'single', artistIds: [artist.id], releaseDate: day(-30), status: 'live' });
      const track = await createTrack(ctx, { title: 'Night Ferries', artistIds: [artist.id], releaseId: release.id });
      const creator = await createContact(ctx, { type: 'creator', name: 'Ola Hart', handles: { tiktok: 'olahart' } });
      const campaign = await svc.createCampaign(ctx, { name: 'Night Ferries push', releaseId: release.id, budgetCents: 200_000, startDate: day(-7), status: 'active', kpis: [{ name: 'Plays', target: 10_000, unit: 'plays', metric: 'streams' }, { name: 'Views', target: 50_000, unit: 'views', metric: 'views' }] });
      return { campaign, track, creator };
    });

    // A creator board comes with the campaign; booking with money needs the spend permission.
    const [board] = (await a.as((ctx) => svc.listBoards(ctx))).filter((b) => b.board.campaignId === campaign.id);
    expect(board.board.kind).toBe('creator');
    await expect(a.as((ctx) => svc.createCard(ctx, { boardId: board.board.id, title: '2 TikToks', offerCents: 30_000 }), PermissionSet.forRole('ar').intersect(PermissionSet.fromPatterns(['marketing:write', 'marketing:read'])))).rejects.toBeInstanceOf(ForbiddenError);
    const card = await a.as((ctx) => svc.createCard(ctx, { boardId: board.board.id, title: '2 TikToks', contactId: creator.id, stage: 'booked', offerCents: 30_000, deliverablesOrdered: 2 }), PermissionSet.forRole('marketing'));
    expect(card.campaignId).toBe(campaign.id);
    await a.as((ctx) => svc.updateCard(ctx, card.id, { paidCents: 30_000, deliverablesDelivered: 2, proofUrls: ['https://www.tiktok.com/@olahart/video/1'], measuredViews: 40_000 }));
    await a.as((ctx) => svc.moveCard(ctx, card.id, { stage: 'paid' }));
    const moved = await systemDb().select().from(domainEvents).where(and(eq(domainEvents.orgId, a.org.id), eq(domainEvents.type, 'marketing.card.moved')));
    expect(moved.map((e) => e.payload)).toEqual([{ cardId: card.id, boardId: board.board.id, from: 'booked', to: 'paid' }]);

    // Plays on the release: 500/day for the 7 days before the start, 1,500/day since.
    let count = 10_000;
    for (let i = 15; i >= 0; i--) {
      count += i <= 7 ? 1_500 : 500;
      await a.as((ctx) => recordSnapshots(ctx, [{ trackId: track.id, platform: 'youtube', source: 'youtube-data-api', externalId: 'VIDEO000001', capturedAt: new Date(Date.now() - i * DAY), count }]));
    }
    const d = await a.as((ctx) => svc.getCampaign(ctx, campaign.id));
    expect(d.stats).toMatchObject({ bookings: 1, paidCents: 30_000, delivered: 2, ordered: 2, views: 40_000, costPer1kCents: 750, unproven: 0 });
    // The first reading (15 days ago) only sets the baseline, so the 8 days before the start hold 7 days of plays.
    expect(d.streamDelta).toMatchObject({ days: 8, during: 8 * 1_500, before: 7 * 500, change: 8 * 1_500 - 7 * 500 });
    expect(d.kpis.map((k) => [k.name, k.measured])).toEqual([['Plays', 12_000], ['Views', 40_000]]);

    // Live campaigns make their release's tracks poll every 6 hours.
    expect([...(await a.as((ctx) => svc.activeCampaignTrackIds(ctx, [track.id])))]).toEqual([track.id]);
    await a.as((ctx) => svc.updateCampaign(ctx, campaign.id, { status: 'completed' }));
    expect((await a.as((ctx) => svc.activeCampaignTrackIds(ctx, [track.id]))).size).toBe(0);

    // Paid spend can't be deleted away.
    await expect(a.as((ctx) => svc.deleteCampaign(ctx, campaign.id))).rejects.toBeInstanceOf(ValidationError);
    await expect(a.as((ctx) => svc.deleteCard(ctx, card.id))).rejects.toBeInstanceOf(ValidationError);
  });

  it('lists what needs doing, most money first', async () => {
    const a = await makeOrg();
    await a.as(async (ctx) => {
      const campaign = await svc.createCampaign(ctx, { name: 'Copper Wire', status: 'active' });
      const loose = await svc.createBoard(ctx, { name: 'Account-level buys', kind: 'creator' });
      const board = await svc.creatorBoardFor(ctx, campaign.id);
      const verified = await createContact(ctx, { type: 'creator', name: 'Verified', handles: { tiktok: 'v' }, payoutEmail: 'v@x.test' });
      const unverified = await createContact(ctx, { type: 'creator', name: 'Unverified', handles: { tiktok: 'u' } });
      await ctx.tx.execute(`update contacts set verified_at = now() where id = '${verified.id}'` as never);
      // Paid, no proof: $500. Delivered short with proof: $200. Unassigned and unproven: $90.
      await svc.createCard(ctx, { boardId: board.id, title: 'No proof', contactId: unverified.id, stage: 'paid', paidCents: 50_000, deliverablesOrdered: 1 });
      await svc.createCard(ctx, { boardId: board.id, title: 'Short', contactId: verified.id, stage: 'posted', paidCents: 20_000, deliverablesOrdered: 3, deliverablesDelivered: 1, proofUrls: ['https://x.test/1'] });
      await svc.createCard(ctx, { boardId: loose.id, title: 'Buyout', stage: 'paid', paidCents: 9_000, measuredViews: 1_000 });
    });
    const o = await a.as((ctx) => svc.marketingOverview(ctx));
    expect(o.cashOutCents).toBe(79_000);
    expect(o.tasks.map((t) => [t.key, t.n, t.moneyCents])).toEqual([
      ['proof', 2, 59_000],
      ['unverified', 1, 50_000],
      ['short', 1, 20_000],
      ['unassigned', 1, 9_000],
      ['payout', 1, 0],
    ]);
    expect(o.clear).toEqual(['Accounts confirmed gone']);
    expect(o.mismatched).toBe(0);
    const csv = await a.as((ctx) => svc.bookingsCsv(ctx));
    expect(csv.split('\n')[0]).toContain('paid_at');
    expect(csv).toContain('500.00');
  });

  it('sends a pitch once, records it in the contact history, and blocks do-not-contact', async () => {
    const a = await makeOrg();
    const { pitch, editor, flaky } = await a.as(async (ctx) => {
      const editor = await createContact(ctx, { type: 'editor', name: 'Indie Finds', email: 'ed@playlists.test' });
      const flaky = await createContact(ctx, { type: 'editor', name: 'Flaky', email: 'down@example.test' });
      const quiet = await createContact(ctx, { type: 'press', name: 'Quiet', email: 'q@x.test', stage: 'do_not_contact' });
      await expect(svc.createPitch(ctx, { contactId: quiet.id, subject: 'Hi', body: 'x' })).rejects.toBeInstanceOf(ConflictError);
      const pitch = await svc.createPitch(ctx, { contactId: editor.id, subject: 'Night Ferries for Indie Finds', body: 'Hi! A new single…' });
      return { pitch, editor, flaky };
    });
    await a.as((ctx) => svc.sendPitch(ctx, pitch.id));
    await runJob(jobs, 'marketing.send-pitch', a.org.id, { pitchId: pitch.id, idempotencyKey: `pitch:${pitch.id}` });
    await runJob(jobs, 'marketing.send-pitch', a.org.id, { pitchId: pitch.id, idempotencyKey: `pitch:${pitch.id}` });
    expect(sent.map((m) => m.to)).toEqual(['ed@playlists.test']);
    const [row] = await a.as((ctx) => ctx.tx.select().from(pitches).where(eq(pitches.id, pitch.id)));
    expect(row.status).toBe('sent');
    expect((await a.as((ctx) => getContact(ctx, editor.id))).interactions[0].summary).toBe('Pitch sent: Night Ferries for Indie Finds');
    await expect(a.as((ctx) => svc.sendPitch(ctx, pitch.id))).rejects.toBeInstanceOf(ConflictError);
    await a.as((ctx) => svc.setPitchOutcome(ctx, pitch.id, { status: 'accepted', outcome: 'Added at #12' }));

    // A transient SMTP failure puts the pitch back to be retried, never half-sent.
    const p2 = await a.as((ctx) => svc.createPitch(ctx, { contactId: flaky.id, subject: 'Hello', body: 'x' }));
    await a.as((ctx) => svc.sendPitch(ctx, p2.id));
    await expect(runJob(jobs, 'marketing.send-pitch', a.org.id, { pitchId: p2.id, idempotencyKey: 'k' })).rejects.toThrow(/421/);
    const [after] = await a.as((ctx) => ctx.tx.select().from(pitches).where(eq(pitches.id, p2.id)));
    expect(after).toMatchObject({ status: 'approved', sentAt: null });
    expect(after.outcome).toMatch(/Not sent yet/);
  });

  it('rejects a sketchboard save based on a stale version', async () => {
    const a = await makeOrg();
    const board = await a.as((ctx) => svc.createSketchboard(ctx, { name: 'Rollout' }));
    const item = { id: 'a', type: 'note' as const, x: 10, y: 10, w: 200, h: 100, text: 'Hook first' };
    const saved = await a.as((ctx) => svc.saveCanvas(ctx, board.id, { items: [item], version: 1 }));
    expect(saved.version).toBe(2);
    await expect(a.as((ctx) => svc.saveCanvas(ctx, board.id, { items: [], version: 1 }))).rejects.toBeInstanceOf(ConflictError);
    expect((await a.as((ctx) => svc.getSketchboard(ctx, board.id))).board.canvas.items).toEqual([item]);
  });
});
