import { eq } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import '../../test/modules';
import { closeDb, systemDb } from '@labelconsole/core/db/client';
import { domainEvents } from '@labelconsole/core/db/schema';
import { closeQueues } from '@labelconsole/core/queue';
import { closeRedis } from '@labelconsole/core/redis';
import { createArtist } from '@labelconsole/people/service';
import { makeOrg } from '../../test/helpers';
import { distributorHints, metadataLookups, platformIdentities, type ResolvedMetadata } from './schema';
import * as svc from './service';

afterAll(async () => {
  await closeQueues();
  await closeDb();
  await closeRedis();
});

describe('catalogue', () => {
  it('tracks readiness through credits, splits and signatures', async () => {
    const a = await makeOrg();
    const { release, track } = await a.as(async (ctx) => {
      const artist = await createArtist(ctx, { name: 'Mara Ellis', status: 'active' });
      const release = await svc.createRelease(ctx, { title: 'Slow Dissolve', type: 'ep', artistIds: [artist.id], upc: '724384960650', releaseDate: '2030-01-10' });
      const track = await svc.createTrack(ctx, { title: 'Tidewater', isrc: 'NL-A1Z-26-00123', releaseId: release.id, artistIds: [artist.id] });
      return { release, track };
    });
    expect(track.blockers).toEqual(['No audio', 'No credits', 'No split sheet']);
    let d = await a.as((ctx) => svc.getRelease(ctx, release.id));
    expect(d.readiness.label).toBe('Blocked by 1 track');
    expect(d.release.upc).toBe('0724384960650');

    await a.as((ctx) => svc.addCredit(ctx, track.id, { name: 'Mara Ellis', role: 'Songwriter' }));
    await expect(a.as((ctx) => svc.saveSplitSheet(ctx, track.id, { parties: [{ name: 'Mara Ellis', sharePct: 60 }, { name: 'Ivo Stern', sharePct: 30 }] }))).rejects.toThrow(/90%/);
    await a.as((ctx) => svc.saveSplitSheet(ctx, track.id, { send: true, parties: [{ name: 'Mara Ellis', sharePct: 60 }, { name: 'Ivo Stern', sharePct: 40 }] }));
    let t = await a.as((ctx) => svc.getTrack(ctx, track.id));
    expect(t.track.blockers).toEqual(['No audio', 'Splits not signed']);
    for (const p of t.splitSheets[0].parties) await a.as((ctx) => svc.setPartySigned(ctx, p.id, true));
    t = await a.as((ctx) => svc.getTrack(ctx, track.id));
    expect(t.splitSheets[0].status).toBe('signed');
    expect(t.track.blockers).toEqual(['No audio']);

    await expect(a.as((ctx) => svc.createTrack(ctx, { title: 'Dupe', isrc: 'NLA1Z2600123' }))).rejects.toThrow(/already used/);
    d = await a.as((ctx) => svc.getRelease(ctx, release.id));
    expect(d.readiness.blockers).toEqual(['Artwork missing']);
  });

  it('confirms a resolved lookup into releases, tracks, artists and identities', async () => {
    const a = await makeOrg();
    const result: ResolvedMetadata = {
      input: { input: 'GBDUW0000059' },
      isrc: 'GBDUW0000059',
      upc: '0724384960650',
      title: 'Harder, Better, Faster, Stronger',
      artists: ['Daft Punk'],
      releaseTitle: 'Discovery',
      releaseType: 'album',
      releaseDate: '2001-03-07',
      labelName: 'Parlophone (France)',
      pLine: null,
      cLine: '℗ 2001 Daft Life',
      durationMs: 224000,
      explicit: false,
      tracks: [
        { title: 'One More Time', isrc: 'GBDUW0000053', durationMs: 320000, position: 1, explicit: false, artists: ['Daft Punk'] },
        { title: 'Harder, Better, Faster, Stronger', isrc: 'GBDUW0000059', durationMs: 224000, position: 4, explicit: false, artists: ['Daft Punk'] },
      ],
      platformIds: [
        { platform: 'deezer', entity: 'track', externalId: '3135556', url: 'https://www.deezer.com/track/3135556', source: 'deezer' },
        { platform: 'deezer', entity: 'release', externalId: '302127', url: null, source: 'deezer' },
      ],
      distributor: { name: 'Warner', confidence: 0.6, evidence: [] },
      conflicts: [],
      sources: [],
    };
    const lookup = await a.as(async (ctx) => {
      const l = await svc.createLookup(ctx, { input: 'GBDUW0000059' }, { enqueue: false });
      await ctx.tx.update(metadataLookups).set({ status: 'done', result }).where(eq(metadataLookups.id, l.id));
      return l;
    });
    const out = await a.as((ctx) => svc.confirmLookup(ctx, lookup.id, { distributor: 'Virgin Music Group' }));
    expect(out).toMatchObject({ created: true, tracks: 2 });

    const d = await a.as((ctx) => svc.getRelease(ctx, out.releaseId));
    expect(d.release.title).toBe('Discovery');
    expect(d.release.status).toBe('live');
    expect(d.release.distributor).toBe('Virgin Music Group');
    expect(d.artists.map((x) => x.name)).toEqual(['Daft Punk']);
    expect(d.tracks.map((x) => x.isrc)).toEqual(['GBDUW0000053', 'GBDUW0000059']);

    const ids = await a.as((ctx) => ctx.tx.select().from(platformIdentities));
    expect(ids.map((i) => `${i.entityType}:${i.platform}:${i.status}`).sort()).toEqual(['release:deezer:confirmed', 'track:deezer:confirmed']);
    const hints = await a.as((ctx) => ctx.tx.select().from(distributorHints));
    expect(hints.map((h) => h.value)).toEqual(expect.arrayContaining(['Parlophone (France)', '0724384']));

    const events = await systemDb().select().from(domainEvents).where(eq(domainEvents.orgId, a.org.id));
    expect(events.filter((e) => e.type === 'catalogue.track.imported')).toHaveLength(2);

    // Confirming again is a no-op that points at the same release.
    expect(await a.as((ctx) => svc.confirmLookup(ctx, lookup.id))).toMatchObject({ releaseId: out.releaseId, created: false });

    // Another label sees none of it.
    const b = await makeOrg();
    expect(await b.as((ctx) => svc.listReleases(ctx))).toHaveLength(0);
  });

  it('parses ISRC/UPC CSVs for bulk import', () => {
    expect(svc.parseCodesCsv('isrc,title\nGBDUW0000059,HBFS\nnot-a-code,x\nGB-DUW-00-00053,OMT\n')).toEqual(['GBDUW0000059', 'GB-DUW-00-00053']);
    expect(svc.parseCodesCsv('724384960650\n724384960650\n')).toEqual(['724384960650']);
  });
});
