import './types';
import { eq } from 'drizzle-orm';
import { memberAccess } from '@labelconsole/core/auth';
import { withOrg } from '@labelconsole/core/context';
import type { JobContext } from '@labelconsole/core/queue';
import type { ResolvedMetadata } from '@labelconsole/catalogue/schema';
import { benchmarkSample, normalizeUpc, normText, recordSpotScraperRequests, resolveContext, resolveMetadata, type BenchmarkItem, type BenchmarkRelease } from '@labelconsole/catalogue/service';
import { discordBenchmarks, type BenchmarkCounts, type BenchmarkResult } from './schema';

/**
 * Source benchmark: the label's own songs are looked up by ISRC through
 * every source, and each source's values are checked against the label's
 * catalogue, the one place where the right answer is known. Measures
 * coverage, agreement, timing and errors before relying on a source.
 */

/** Fields checked against the catalogue. */
export const BENCHMARK_FIELDS = ['title', 'artists', 'durationMs', 'upc', 'releaseDate', 'labelName', 'pLine', 'cLine'] as const;
type Field = (typeof BENCHMARK_FIELDS)[number];

const MAX_MISSES = 30;

/** Copyright lines compare without the ℗/© marks; everything compares without case and punctuation. */
const canon = (v: string) => normText(v.replace(/[℗©]|\((p|c)\)/gi, ' '));
const close = (a: string, b: string) => {
  const x = canon(a);
  const y = canon(b);
  return Boolean(x && y) && (x === y || x.includes(y) || y.includes(x));
};

/** The release a source's values describe: the one with its UPC, else the song's first release. */
function releaseFor(item: BenchmarkItem, upc: string | null | undefined): BenchmarkRelease | null {
  const n = upc ? normalizeUpc(upc) : null;
  return (n ? item.releases.find((r) => r.upc && normalizeUpc(r.upc) === n) : null) ?? item.releases[0] ?? null;
}

/** The catalogue's value for a field, and whether a reported value agrees with it. */
function check(item: BenchmarkItem, field: Field, value: string, upc: string | null | undefined): { truth: string | null; agrees: boolean } {
  const rel = releaseFor(item, upc);
  switch (field) {
    case 'title':
      return { truth: item.title, agrees: close(value, item.title) };
    case 'artists': {
      const primary = item.artists[0];
      return { truth: primary ?? null, agrees: Boolean(primary) && canon(value).includes(canon(primary)) };
    }
    case 'durationMs':
      return { truth: item.durationMs == null ? null : String(item.durationMs), agrees: item.durationMs != null && Math.abs(Number(value) - item.durationMs) <= 2000 };
    case 'upc': {
      const upcs = item.releases.map((r) => (r.upc ? normalizeUpc(r.upc) : null)).filter((u): u is string => Boolean(u));
      return { truth: upcs.join(', ') || null, agrees: upcs.includes(normalizeUpc(value) ?? value) };
    }
    case 'releaseDate':
      return { truth: rel?.releaseDate ?? null, agrees: Boolean(rel?.releaseDate) && value.slice(0, 10) === rel!.releaseDate!.slice(0, 10) };
    case 'labelName':
    case 'pLine':
    case 'cLine': {
      const truth = rel?.[field] ?? null;
      return { truth, agrees: Boolean(truth) && close(value, truth!) };
    }
  }
}

const empty = (): Record<string, BenchmarkCounts> => Object.fromEntries(BENCHMARK_FIELDS.map((f) => [f, { reported: 0, checked: 0, agreed: 0 }]));

function tally(counts: Record<string, BenchmarkCounts>, item: BenchmarkItem, field: Field, value: string | null | undefined, upc: string | null | undefined) {
  if (value == null || value === '') return null;
  const c = counts[field];
  c.reported++;
  const r = check(item, field, value, upc);
  if (r.truth == null) return null;
  c.checked++;
  if (r.agrees) c.agreed++;
  return r;
}

const percentile = (xs: number[], p: number) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return Math.round(s[Math.min(s.length - 1, Math.floor(p * s.length))]);
};

/** Score lookups against the catalogue. Pure, so it can be tested without any source. */
export function scoreBenchmark(runs: Array<{ item: BenchmarkItem; md: ResolvedMetadata | null }>, billed = 0): BenchmarkResult {
  const sources = new Map<string, { outcomes: Record<string, number>; ms: number[]; fields: Record<string, BenchmarkCounts> }>();
  const merged = empty();
  const distributor = { checked: 0, agreed: 0, unknown: 0 };
  const misses: BenchmarkResult['misses'] = [];

  for (const { item, md } of runs) {
    if (!md) continue;
    for (const s of md.sources) {
      const e = sources.get(s.source) ?? { outcomes: {}, ms: [], fields: empty() };
      const outcome = s.outcome ?? (s.ok ? 'answered' : s.skipped ? 'skipped' : 'error');
      e.outcomes[outcome] = (e.outcomes[outcome] ?? 0) + 1;
      if (s.ms != null && !['skipped', 'paused', 'busy'].includes(outcome)) e.ms.push(s.ms);
      sources.set(s.source, e);
    }
    for (const c of md.claims ?? []) {
      const e = sources.get(c.source) ?? { outcomes: {}, ms: [], fields: empty() };
      sources.set(c.source, e);
      for (const f of BENCHMARK_FIELDS) {
        const value = c.values[f];
        const r = tally(e.fields, item, f, value, c.upc);
        if (r && !r.agrees && misses.length < MAX_MISSES) misses.push({ isrc: item.isrc, title: item.title.slice(0, 80), field: f, source: c.source, ours: r.truth!.slice(0, 80), theirs: value!.slice(0, 80) });
      }
    }
    const shown: Record<Field, string | null> = {
      title: md.title,
      artists: md.artists.join(', ') || null,
      durationMs: md.durationMs == null ? null : String(md.durationMs),
      upc: md.upc,
      releaseDate: md.releaseDate,
      labelName: md.labelName,
      pLine: md.pLine,
      cLine: md.cLine,
    };
    for (const f of BENCHMARK_FIELDS) tally(merged, item, f, shown[f], md.upc);

    // The inferred distributor against releases whose distributor the label has confirmed.
    const rel = releaseFor(item, md.upc);
    const confirmed = rel?.distributor && (rel.distributorConfidence == null || rel.distributorConfidence >= 1) ? rel.distributor : null;
    if (confirmed) {
      distributor.checked++;
      if (!md.distributor.name || md.distributor.confidence <= 0) distributor.unknown++;
      else if (close(md.distributor.name, confirmed)) distributor.agreed++;
    }
  }

  return {
    items: runs.length,
    sources: [...sources.entries()]
      .map(([source, e]) => ({ source, outcomes: e.outcomes, p50: percentile(e.ms, 0.5), p95: percentile(e.ms, 0.95), fields: e.fields }))
      .sort((a, b) => a.source.localeCompare(b.source)),
    merged,
    distributor,
    billed: { spotscraper: billed },
    misses,
  };
}

/** The job: look the sample up one song at a time (MusicBrainz allows one request a second) and store the score. */
export async function runBenchmark(job: JobContext, benchmarkId: string) {
  const orgId = job.orgId!;
  const [row] = await job.withOrg((ctx) => ctx.tx.select().from(discordBenchmarks).where(eq(discordBenchmarks.id, benchmarkId)));
  if (!row || row.status !== 'queued') return { skipped: 'not queued' };
  const set = (values: Partial<typeof discordBenchmarks.$inferInsert>) => job.withOrg((ctx) => ctx.tx.update(discordBenchmarks).set(values).where(eq(discordBenchmarks.id, benchmarkId)));
  await set({ status: 'running' });
  try {
    // The sample is read as the person who asked: their artist scope applies.
    const access = row.requestedBy ? await memberAccess(row.requestedBy, orgId) : null;
    if (!access || !access.permissions.has('settings:manage')) throw new Error('The person who started this benchmark can no longer manage settings.');
    const items = await withOrg({ orgId, actor: { type: 'user', id: access.user.id, name: access.user.name }, permissions: access.permissions, artistScope: access.artistScope }, (ctx) => benchmarkSample(ctx, row.sample));
    if (!items.length) throw new Error('Your catalogue has no songs with an ISRC to test with.');
    const rctx = await job.withOrg((ctx) => resolveContext(ctx));
    if (!row.includeBilled) rctx.creds.spotscraper = null;
    const runs: Array<{ item: BenchmarkItem; md: ResolvedMetadata | null }> = [];
    let billed = 0;
    try {
      for (const item of items) {
        const md = await resolveMetadata({ kind: 'isrc', isrc: item.isrc }, { input: item.isrc, via: 'benchmark' }, rctx).catch((err) => {
          job.log.warn({ err, isrc: item.isrc }, 'benchmark lookup failed');
          return null;
        });
        runs.push({ item, md });
        billed += rctx.creds.spotscraper?.requests ?? 0;
        await job.withOrg((ctx) => recordSpotScraperRequests(ctx, rctx.creds.spotscraper));
        await set({ progress: runs.length });
      }
    } finally {
      await job.withOrg((ctx) => recordSpotScraperRequests(ctx, rctx.creds.spotscraper)).catch(() => undefined);
    }
    const results = scoreBenchmark(runs, billed);
    await set({ status: 'done', results, finishedAt: new Date() });
    return { items: results.items };
  } catch (err) {
    await set({ status: 'failed', error: (err as Error).message.slice(0, 300), finishedAt: new Date() });
    throw err;
  }
}
