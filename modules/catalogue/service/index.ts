import '../types';
import { and, asc, eq, gte, inArray, isNotNull, ne, sql } from 'drizzle-orm';
import type { ServiceContext } from '@labelconsole/core/context';
import { releaseArtists, releases, splitSheets } from '../schema';
import { today } from './shared';

export * from './releases';
export * from './tracks';
export * from './demos';
export * from './identities';
export * from './imports';
export { formatIsrc } from './shared';
export { displayUpc } from '../metadata/input';

export async function nextRelease(ctx: ServiceContext) {
  const [r] = await ctx.tx
    .select()
    .from(releases)
    .where(and(isNotNull(releases.releaseDate), gte(releases.releaseDate, today()), ne(releases.status, 'taken_down')))
    .orderBy(asc(releases.releaseDate))
    .limit(1);
  return r ?? null;
}

export async function splitSheetCounts(ctx: ServiceContext) {
  const [r] = await ctx.tx.select({ n: sql<number>`count(*)::int`, oldest: sql<Date | null>`min(${splitSheets.sentAt})` }).from(splitSheets).where(ne(splitSheets.status, 'signed'));
  return { unsigned: r.n, oldestSent: r.oldest };
}

/** Releases per artist (total and live), for the People module's artist rows. */
export async function releaseCountsByArtist(ctx: ServiceContext, artistIds: string[]) {
  if (artistIds.length === 0) return [];
  return ctx.tx
    .select({ artistId: releaseArtists.artistId, total: sql<number>`count(*)::int`, live: sql<number>`count(*) filter (where ${releases.status} = 'live')::int` })
    .from(releaseArtists)
    .innerJoin(releases, eq(releases.id, releaseArtists.releaseId))
    .where(inArray(releaseArtists.artistId, artistIds))
    .groupBy(releaseArtists.artistId);
}
