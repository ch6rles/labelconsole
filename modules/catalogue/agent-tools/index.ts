import { z } from 'zod';
import { compact, defineTool } from '@labelconsole/core/tools';
import { DEMO_STAGES, RELEASE_STATUSES, RELEASE_TYPES } from '../schema';
import * as svc from '../service';

/**
 * Catalogue data given to agents comes from the label's own records
 * (normalised metadata it owns), never raw Spotify API responses.
 */
export const tools = [
  defineTool({
    name: 'catalogue_search',
    module: 'catalogue',
    description: 'Search the catalogue for releases and tracks by title, UPC, ISRC or catalogue number. Returns ids for use with the other catalogue tools.',
    input: z.object({ q: z.string().min(1).max(100), limit: z.number().int().min(1).max(50).default(10) }),
    permission: 'catalogue:read',
    risk: 'read',
    idempotent: true,
    execute: (t, i) =>
      t.withOrg(async (ctx) => {
        const [rels, trks] = await Promise.all([svc.listReleases(ctx, { q: i.q }), svc.listTracks(ctx, { q: i.q })]);
        return {
          releases: rels.slice(0, i.limit).map((r) => ({ id: r.id, title: r.title, type: r.type, upc: svc.displayUpc(r.upc), releaseDate: r.releaseDate, status: r.status, artists: r.artists.map((a) => a.name), readiness: r.readiness.label })),
          tracks: trks.slice(0, i.limit).map((t) => ({ id: t.id, title: t.title, isrc: t.isrc, artists: t.artists.map((a) => a.name), releases: t.releases.map((r) => r.title), status: t.status, blockers: t.blockers })),
        };
      }),
  }),
  defineTool({
    name: 'catalogue_get_track',
    module: 'catalogue',
    description: 'Get a track: ISRC, duration, artists (with their ids), credits, split sheets and signature status, releases it appears on, and platform ids.',
    input: z.object({ id: z.uuid() }),
    permission: 'catalogue:read',
    risk: 'read',
    idempotent: true,
    execute: (t, i) =>
      t.withOrg(async (ctx) => {
        const d = await svc.getTrack(ctx, i.id);
        return compact({
          id: d.track.id,
          title: d.track.title,
          version: d.track.version,
          isrc: d.track.isrc,
          durationMs: d.track.durationMs,
          explicit: d.track.explicit,
          status: d.track.status,
          blockers: d.track.blockers,
          artists: d.artists.map((a) => ({ id: a.id, name: a.name })),
          releases: d.releases.map((r) => ({ id: r.id, title: r.title, releaseDate: r.releaseDate })),
          credits: d.credits.map((c) => `${c.role}: ${c.name}`),
          splits: d.splitSheets.map((s) => ({ kind: s.kind, status: s.status, parties: s.parties.map((p) => ({ name: p.name, share: Number(p.sharePct), signed: Boolean(p.signedAt) })) })),
          platforms: d.identities.filter((x) => x.status !== 'rejected').map((x) => ({ platform: x.platform, id: x.externalId, status: x.status })),
        });
      }),
  }),
  defineTool({
    name: 'catalogue_get_release',
    module: 'catalogue',
    description: 'Get a release with its tracklist, readiness, checklist and distributor guess.',
    input: z.object({ id: z.uuid() }),
    permission: 'catalogue:read',
    risk: 'read',
    idempotent: true,
    execute: (t, i) =>
      t.withOrg(async (ctx) => {
        const d = await svc.getRelease(ctx, i.id);
        return compact({
          id: d.release.id,
          title: d.release.title,
          type: d.release.type,
          upc: svc.displayUpc(d.release.upc),
          releaseDate: d.release.releaseDate,
          status: d.release.status,
          label: d.release.labelName,
          distributor: d.release.distributor,
          artists: d.artists.map((a) => a.name),
          readiness: d.readiness,
          checklist: d.release.checklist,
          tracks: d.tracks.map((tr) => ({ id: tr.id, position: tr.position, title: tr.title, isrc: tr.isrc, blockers: tr.blockers })),
        });
      }),
  }),
  defineTool({
    name: 'catalogue_release_checklist',
    module: 'catalogue',
    description: 'List upcoming releases (optionally within N days) with what still blocks each one: track blockers, missing artwork, UPC or date, and open checklist steps.',
    input: z.object({ withinDays: z.number().int().min(1).max(365).default(60) }),
    permission: 'catalogue:read',
    risk: 'read',
    idempotent: true,
    execute: (t, i) =>
      t.withOrg(async (ctx) => {
        const horizon = new Date(Date.now() + i.withinDays * 86400_000).toISOString().slice(0, 10);
        const list = (await svc.listReleases(ctx)).filter((r) => r.upcoming && (!r.releaseDate || r.releaseDate <= horizon));
        return list.map((r) => ({ id: r.id, title: r.title, releaseDate: r.releaseDate, status: r.status, readiness: r.readiness.label, blockers: r.readiness.blockers, openSteps: r.checklist.filter((c) => !c.done).map((c) => c.label) }));
      }),
  }),
  defineTool({
    name: 'catalogue_create_release_draft',
    module: 'catalogue',
    description: 'Create a new release in "collecting" status (a draft). Use for planning; tracks and artwork are added later.',
    input: z.object({ title: z.string().min(1).max(300), type: z.enum(RELEASE_TYPES).default('single'), releaseDate: z.iso.date().optional(), artistIds: z.array(z.uuid()).max(10).optional(), notes: z.string().max(2000).optional() }),
    permission: 'catalogue:write',
    risk: 'write',
    preview: (i) => `Create ${i.type} draft "${i.title}"${i.releaseDate ? ` for ${i.releaseDate}` : ''}`,
    execute: (t, i) => t.withOrg(async (ctx) => {
      const r = await svc.createRelease(ctx, { ...i, status: 'collecting' });
      return { id: r.id, title: r.title };
    }),
  }),
  defineTool({
    name: 'catalogue_update_release',
    module: 'catalogue',
    description: 'Edit release metadata (date, status, label, distributor, P/C lines, catalogue number, notes) or tick a checklist step.',
    input: z.object({
      id: z.uuid(),
      releaseDate: z.iso.date().nullable().optional(),
      status: z.enum(RELEASE_STATUSES).optional(),
      labelName: z.string().max(200).nullable().optional(),
      distributor: z.string().max(120).nullable().optional(),
      catalogNumber: z.string().max(40).nullable().optional(),
      pLine: z.string().max(300).nullable().optional(),
      cLine: z.string().max(300).nullable().optional(),
      notes: z.string().max(5000).nullable().optional(),
      checklistItemDone: z.string().max(60).optional().describe('Id of a checklist step to mark done'),
    }),
    permission: 'catalogue:write',
    risk: 'write',
    preview: (i) => `Edit release ${i.id}: ${Object.keys(i).filter((k) => k !== 'id').join(', ')}`,
    execute: (t, { id, checklistItemDone, ...patch }) =>
      t.withOrg(async (ctx) => {
        if (Object.keys(patch).length) await svc.updateRelease(ctx, id, patch);
        if (checklistItemDone) await svc.setChecklistItem(ctx, id, { itemId: checklistItemDone, done: true });
        const d = await svc.getRelease(ctx, id);
        return { id, title: d.release.title, readiness: d.readiness.label };
      }),
  }),
  defineTool({
    name: 'catalogue_list_demos',
    module: 'catalogue',
    description: 'List demo submissions, newest unreviewed first. Each has links, genre, notes, an audio file id, and any existing A&R score.',
    input: z.object({ stage: z.enum(DEMO_STAGES).optional(), limit: z.number().int().min(1).max(100).default(25) }),
    permission: 'catalogue:read',
    risk: 'read',
    idempotent: true,
    execute: (t, i) =>
      t.withOrg(async (ctx) => (await svc.listDemos(ctx, { stage: i.stage })).slice(0, i.limit).map((d) => ({ id: d.id, title: d.title, artist: d.artistName, genre: d.genre, links: d.links, notes: d.notes, audioFileId: d.audioFileId, stage: d.stage, score: d.score ? Number(d.score) : null, submittedAt: d.createdAt }))),
  }),
  defineTool({
    name: 'catalogue_score_demo',
    module: 'catalogue',
    description: "Record an A&R score for a demo (0-10 for fit with the label's taste, production quality, and potential) with a short rationale.",
    input: svc.ScoreInput.extend({ id: z.uuid() }),
    permission: 'catalogue:write',
    risk: 'write',
    idempotent: true,
    preview: (i) => `Score demo ${i.id}: fit ${i.fit}, production ${i.production}, potential ${i.potential}`,
    execute: (t, { id, ...score }) => t.withOrg(async (ctx) => {
      const d = await svc.scoreDemo(ctx, id, score);
      return { id: d.id, score: Number(d.score) };
    }),
  }),
  defineTool({
    name: 'catalogue_sync_spotify_artist',
    module: 'catalogue',
    description:
      "Bring a roster artist's releases on Spotify into the catalogue (releases, tracks, UPC, ISRCs, label, release date), skipping ones already there. Runs in the background; play counts then appear in Streams. The artist needs a Spotify artist link on their profile. onlyLabel keeps only releases that name the label in their label or ℗ line. No audio files are downloaded.",
    input: z.object({ artistId: z.uuid().describe('Roster artist id (people_list_roster)'), onlyLabel: z.boolean().default(false) }),
    permission: 'catalogue:write',
    risk: 'write',
    preview: (i) => `Sync a roster artist's releases from Spotify into the catalogue${i.onlyLabel ? ' (label releases only)' : ''}`,
    execute: (t, i) =>
      t.withOrg(async (ctx) => {
        const row = await svc.requestSpotifySync(ctx, i.artistId, { onlyLabel: i.onlyLabel });
        return { importId: row.id, status: 'started', note: 'Releases are imported in the background; check the artist page or catalogue_search later.' };
      }),
  }),
];
