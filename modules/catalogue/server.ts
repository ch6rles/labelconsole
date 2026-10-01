import './types';
import { and, eq, ilike, inArray, or, sql } from 'drizzle-orm';
import * as fmt from '@labelconsole/ui/format';
import { defineModule } from '@labelconsole/core/modules';
import { tools } from './agent-tools';
import { routes } from './api';
import { jobs } from './jobs';
import { manifest } from './manifest';
import { demos, releases, tracks } from './schema';
import * as svc from './service';

export default defineModule({
  manifest,
  routes,
  onboarding: async (ctx) => {
    const [r] = await ctx.tx.select({ n: sql<number>`count(*)::int` }).from(releases);
    return [{ id: 'release', title: 'Add a release', sub: 'Paste a Spotify, Apple or Deezer link, an ISRC or a UPC and the details are looked up for you', done: (r?.n ?? 0) > 0, href: '/catalog/releases', order: 40 }];
  },
  jobs,
  tools,
  widgets: [
    {
      id: 'demos',
      name: 'Demo Inbox',
      icon: 'inbox',
      desc: 'Unreviewed demos and the newest arrival',
      permission: 'catalogue:read',
      load: async (ctx) => {
        const c = await svc.demoCounts(ctx);
        return { value: String(c.unreviewed), unit: 'awaiting review', line: c.newest ? `Newest: "${c.newest.title}" from ${c.newest.artistName}` : 'No new demos', cta: 'Review demos', href: '/catalog/demos' };
      },
    },
    {
      id: 'calendar',
      name: 'Release Calendar',
      icon: 'calendar_month',
      desc: 'Next release date and what blocks it',
      permission: 'catalogue:read',
      load: async (ctx) => {
        const next = await svc.nextRelease(ctx);
        if (!next) return { value: '—', unit: 'no release scheduled', line: 'Nothing dated in the future', cta: 'Open releases', href: '/catalog/releases' };
        const d = await svc.getRelease(ctx, next.id);
        return { value: fmt.shortDate(next.releaseDate), unit: 'next release', line: `${next.title} · ${d.readiness.tone === 'ready' ? 'ready' : d.readiness.label.toLowerCase()}`, cta: 'Open releases', href: `/catalog/releases/${next.id}` };
      },
    },
    {
      id: 'splits',
      name: 'Splits',
      icon: 'call_split',
      desc: 'Split sheets waiting on signatures',
      permission: 'catalogue:read',
      load: async (ctx) => {
        const s = await svc.splitSheetCounts(ctx);
        return { value: String(s.unsigned), unit: 'unsigned sheets', line: s.oldestSent ? `Oldest waiting ${fmt.daysBetween(s.oldestSent)} days` : 'Nothing waiting on signatures', cta: 'Chase signatures', href: '/finance/splits' };
      },
    },
  ],
  attention: async (ctx) => {
    if (!ctx.can('catalogue:read')) return [];
    const [d, list, s] = await Promise.all([svc.demoCounts(ctx), svc.listReleases(ctx), svc.splitSheetCounts(ctx)]);
    const upcoming = list.filter((r) => r.upcoming);
    const blocked = upcoming.filter((r) => r.readiness.tone === 'blocked');
    const monthEnd = new Date(new Date().getFullYear(), new Date().getMonth() + 1, 0).toISOString().slice(0, 10);
    const intake = list.filter((r) => r.intake && r.readiness.trackCount > 0);
    return [
      { n: d.unreviewed, tone: 'ink', title: 'Demos awaiting review', sub: d.oldest ? `Oldest submitted ${fmt.daysBetween(d.oldest)} days ago` : '', href: '/catalog/demos' },
      { n: upcoming.length, tone: 'ink', title: 'Signed, not yet released', sub: `${upcoming.filter((r) => r.releaseDate && r.releaseDate <= monthEnd).length} scheduled before the end of the month`, href: '/catalog/releases' },
      { n: blocked.length, tone: 'red', title: 'Upcoming releases blocked', sub: blocked.slice(0, 2).map((r) => `${r.title}: ${r.readiness.label.toLowerCase()}`).join(' · '), href: '/catalog/releases' },
      { n: s.unsigned, tone: 'ink', title: 'Split sheets not fully signed', sub: s.oldestSent ? `Oldest waiting ${fmt.daysBetween(s.oldestSent)} days` : '', href: '/finance/splits' },
      ...(intake.length ? [{ n: intake.length, tone: 'ink' as const, title: 'Release intake to promote', sub: `${intake[0].title} has tracks in`, href: '/catalog/releases' }] : []),
    ];
  },
  search: async (ctx, q) => {
    if (!ctx.can('catalogue:read')) return [];
    const digits = q.replace(/\D/g, '');
    const [r, t, dm] = await Promise.all([
      ctx.tx.select({ id: releases.id, title: releases.title, type: releases.type }).from(releases).where(or(ilike(releases.title, `%${q}%`), digits.length >= 6 ? ilike(releases.upc, `%${digits}%`) : undefined, ilike(releases.catalogNumber, `%${q}%`))).limit(5),
      ctx.tx.select({ id: tracks.id, title: tracks.title, isrc: tracks.isrc }).from(tracks).where(or(ilike(tracks.title, `%${q}%`), ilike(tracks.isrc, `%${q.replace(/[^A-Za-z0-9]/g, '')}%`))).limit(5),
      ctx.tx.select({ id: demos.id, title: demos.title, artistName: demos.artistName }).from(demos).where(and(or(ilike(demos.title, `%${q}%`), ilike(demos.artistName, `%${q}%`)))).limit(3),
    ]);
    return [
      ...r.map((x) => ({ type: 'Release', title: x.title, sub: `Release · ${x.type}`, href: `/catalog/releases/${x.id}`, icon: 'album' })),
      ...t.map((x) => ({ type: 'Track', title: x.title, sub: x.isrc ?? 'Track', href: `/catalog/tracks/${x.id}`, icon: 'music_note' })),
      ...dm.map((x) => ({ type: 'Demo', title: x.title, sub: `Demo · ${x.artistName}`, href: `/catalog/demos?open=${x.id}`, icon: 'inbox' })),
    ];
  },
  enrich: {
    artist: async (ctx, ids) => {
      if (!ctx.can('catalogue:read')) return {};
      const rows = await svc.releaseCountsByArtist(ctx, ids);
      return Object.fromEntries(rows.map((r) => [r.artistId, { releases: r.total, liveReleases: r.live }]));
    },
  },
});

export { eq, inArray };
