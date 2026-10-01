import { eq } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import '../../test/modules';
import { closeDb } from '@labelconsole/core/db/client';
import { ForbiddenError } from '@labelconsole/core/errors';
import { PermissionSet } from '@labelconsole/core/permissions';
import { closeQueues } from '@labelconsole/core/queue';
import { closeRedis } from '@labelconsole/core/redis';
import { createRelease, createTrack, linkTrack } from '@labelconsole/catalogue/service';
import { createArtist } from '@labelconsole/people/service';
import { makeOrg } from '../../test/helpers';
import { documents, keyDates, statementLines } from './schema';
import * as svc from './service';

afterAll(async () => {
  await closeQueues();
  await closeDb();
  await closeRedis();
});

const TERMS = {
  agreementType: 'Exclusive recording agreement',
  effectiveDate: '2026-01-01',
  termDescription: '3 years',
  termEndDate: '2028-12-31',
  territory: 'World',
  royaltyArtistPct: 40,
  royaltyLabelPct: 60,
  royaltyBasis: 'Net receipts',
  advanceAmount: 5000,
  advanceCurrency: 'USD',
  recoupment: 'Recoupable from artist royalties',
  options: [{ description: 'Option for a second album', exerciseBy: '2027-06-30' }],
  keyDates: [{ kind: 'notice' as const, date: '2028-09-30', description: 'Notice of non-renewal due' }],
  releasesCovered: ['Slow Dissolve'],
  notes: null,
};

describe('documents', () => {
  it('confirms reviewed terms into key dates, links and contract status', async () => {
    const a = await makeOrg();
    const { doc, artist } = await a.as(async (ctx) => {
      const artist = await createArtist(ctx, { name: 'Mara Ellis', status: 'active' });
      const [doc] = await ctx.tx.insert(documents).values({ type: 'contract', title: 'Mara Ellis recording agreement', contractStatus: 'signed', signedAt: '2026-01-02', extractionStatus: 'done', extractedTerms: { ...TERMS, parties: [{ name: 'Mara Ellis', role: 'artist' }] } }).returning();
      return { doc, artist };
    });

    // Extraction alone sets nothing.
    expect(await a.as((ctx) => ctx.tx.select().from(keyDates).where(eq(keyDates.documentId, doc.id)))).toHaveLength(0);

    await a.as((ctx) => svc.confirmTerms(ctx, doc.id, { ...TERMS, parties: [{ name: 'Mara Ellis', role: 'artist', artistId: artist.id }, { name: 'Test Label', role: 'label' }] }));
    const d = await a.as((ctx) => svc.getDocument(ctx, doc.id));
    expect(d.document.expiryDate).toBe('2028-12-31');
    expect(d.document.termsConfirmedAt).toBeTruthy();
    expect(d.keyDates.map((k) => [k.kind, k.date])).toEqual([
      ['option', '2027-06-30'],
      ['notice', '2028-09-30'],
      ['expiry', '2028-12-31'],
    ]);
    expect(d.artists.map((x) => x.name)).toEqual(['Mara Ellis']);

    const contracts = await a.as((ctx) => svc.contractsForArtists(ctx, [artist.id]));
    expect(svc.contractLabel(contracts)).toBe('Signed');
    expect(svc.contractLabel([{ contractStatus: 'signed', expiryDate: new Date(Date.now() + 20 * 86400_000).toISOString().slice(0, 10) }])).toMatch(/^Expiring /);
    expect(svc.contractLabel([{ contractStatus: 'draft', expiryDate: null }])).toBe('Unsigned');

    // Confirming again replaces the dates instead of duplicating them.
    await a.as((ctx) => svc.confirmTerms(ctx, doc.id, { ...TERMS, options: [], parties: [] }));
    expect((await a.as((ctx) => svc.getDocument(ctx, doc.id))).keyDates).toHaveLength(2);

    // Upcoming dates for the next 3 years include the notice deadline.
    const upcoming = await a.as((ctx) => svc.upcomingKeyDates(ctx, 365 * 3));
    expect(upcoming.map((u) => u.keyDate.kind)).toContain('notice');
  });

  it('hides confidential documents and statements from roles without access', async () => {
    const a = await makeOrg();
    const { secret, statement, open } = await a.as(async (ctx) => {
      const [secret] = await ctx.tx.insert(documents).values({ type: 'contract', title: 'Settlement', confidential: true }).returning();
      const [statement] = await ctx.tx.insert(documents).values({ type: 'statement', title: 'DistroKid Jul 2026' }).returning();
      const [open] = await ctx.tx.insert(documents).values({ type: 'other', title: 'Press kit' }).returning();
      return { secret, statement, open };
    });
    const marketing = PermissionSet.forRole('marketing');
    const visible = await a.as((ctx) => svc.listDocuments(ctx), marketing);
    expect(visible.map((v) => v.id)).toEqual([open.id]);
    await expect(a.as((ctx) => svc.getDocument(ctx, secret.id), marketing)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(a.as((ctx) => svc.getDocument(ctx, statement.id), marketing)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(a.as((ctx) => svc.royalties(ctx), marketing)).rejects.toBeInstanceOf(ForbiddenError);

    // Finance sees statements and confidential documents; viewing a confidential one is logged.
    const finance = PermissionSet.forRole('finance');
    expect((await a.as((ctx) => svc.listDocuments(ctx), finance)).map((v) => v.id).sort()).toEqual([secret.id, statement.id, open.id].sort());
    await a.as((ctx) => svc.getDocument(ctx, secret.id), finance);
    const log = await a.as((ctx) => svc.accessLog(ctx, secret.id));
    expect(log.map((l) => l.action)).toEqual(['view']);

    // Another label sees none of it.
    const b = await makeOrg('Other Label');
    expect(await b.as((ctx) => svc.listDocuments(ctx))).toEqual([]);
  });

  it('splits booked revenue by confirmed terms without double counting shared tracks', async () => {
    const a = await makeOrg();
    await a.as(async (ctx) => {
      const artist = await createArtist(ctx, { name: 'Juno Vale', status: 'active' });
      const single = await createRelease(ctx, { title: 'Night Ferries', type: 'single', artistIds: [artist.id] });
      const album = await createRelease(ctx, { title: 'Harbour', type: 'album', artistIds: [artist.id] });
      const track = await createTrack(ctx, { title: 'Night Ferries', isrc: 'GBNLR2600011', artistIds: [artist.id], releaseId: single.id });
      await linkTrack(ctx, album.id, track.id, 1);
      const [contract] = await ctx.tx.insert(documents).values({ type: 'contract', title: 'Juno Vale licence', contractStatus: 'signed' }).returning();
      await svc.confirmTerms(ctx, contract.id, { ...TERMS, keyDates: [], options: [], parties: [{ name: 'Juno Vale', role: 'artist', artistId: artist.id }] });
      const [statement] = await ctx.tx.insert(documents).values({ type: 'statement', title: 'Jul', extractionStatus: 'done' }).returning();
      const month = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth() - 1, 1)).toISOString().slice(0, 10);
      await ctx.tx.insert(statementLines).values([
        { documentId: statement.id, periodStart: month, periodEnd: month, source: 'Spotify', isrc: 'GBNLR2600011', trackId: track.id, units: 10000, grossCents: 5000, netCents: 4000 },
        { documentId: statement.id, periodStart: month, periodEnd: month, source: 'Apple Music', isrc: 'GBNLR2600011', trackId: track.id, units: 2000, grossCents: 1500, netCents: 1000 },
        { documentId: statement.id, periodStart: month, periodEnd: month, source: 'Spotify', isrc: 'XXAAA2600001', units: 50, grossCents: 300, netCents: 200 },
      ]);
    });
    const r = await a.as((ctx) => svc.royalties(ctx));
    expect(r.totals).toEqual({ grossCents: 6800, netCents: 5200, artistShareCents: 2000, labelShareCents: 3000, uncoveredCents: 200, unmatchedCents: 200 });
    expect(r.top[0]).toMatchObject({ artist: 'Juno Vale', units: 12000, netCents: 5000, artistShareCents: 2000, labelShareCents: 3000 });
    expect(r.bySource).toEqual([{ source: 'Spotify', netCents: 4200 }, { source: 'Apple Music', netCents: 1000 }]);
    const csv = await a.as((ctx) => svc.royaltiesCsv(ctx));
    expect(csv.trim().split('\n')).toHaveLength(4);
    expect(csv).toContain('GBNLR2600011');
  });
});
