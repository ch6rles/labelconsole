import './types';
import { memberAccess, type MemberAccess } from '@labelconsole/core/auth';
import { withOrg, type ServiceContext } from '@labelconsole/core/context';
import { env } from '@labelconsole/core/env';
import { ProviderError, RateLimitedError } from '@labelconsole/core/errors';
import { fetchJson } from '@labelconsole/core/http';
import { enabledModuleIds } from '@labelconsole/core/modules';
import type { JobContext } from '@labelconsole/core/queue';
import { redis } from '@labelconsole/core/redis';
import type { ResolvedMetadata } from '@labelconsole/catalogue/schema';
import {
  creditsForName,
  distributorReference,
  fetchCredits,
  getReleaseRow,
  getTrack,
  listReleases,
  listTracks,
  normalizeIsrc,
  normalizeUpc,
  parseInput,
  recordSpotScraperRequests,
  releasesByDistributor,
  releasesByLabel,
  resolveContext,
  resolveMetadata,
  searchCandidates,
  searchReleaseCandidates,
  unambiguousCandidate,
  type ParsedInput,
} from '@labelconsole/catalogue/service';
import { statementCodesFor, statementDistributors } from '@labelconsole/documents/service';
import { findArtistByName } from '@labelconsole/people/service';
import { playsByTrack, trackHistory } from '@labelconsole/streams/service';
import { renderChart } from './chart';
import { CORRECTABLE_FIELDS } from './protocol/commands';
import { editOriginal } from './protocol/rest';
import type { MessageFile, MessagePayload } from './protocol/types';
import {
  audioView,
  cardTitle,
  chartView,
  creditsView,
  distributorEvidence,
  fieldEvidence,
  fitEmbeds,
  linksView,
  PICK_IDS,
  renderArtist,
  renderCard,
  renderChoice,
  renderCompare,
  renderLabel,
  renderLicensor,
  renderNotice,
  renderPicker,
  renderView,
  type Card,
  type CardKind,
  type ChartSeries,
  type OwnedRelease,
} from './render';
import { approvedCorrections, createCorrection, DEGRADED, evidenceFor, findLink, readingsFor, recordEvidence, recordLookup, recordReading, sharingFor, touchLink, USE_PERMISSION, type LookupLog } from './service';
import { deezerArtist, deezerArtistReleases, labelReleaseCount, musicbrainzArtist, musicbrainzLabel, musicbrainzWorks, pickArtist, pickLabel, searchArtists, searchLabels, type DeezerArtist, type MbLabel } from './sources';
import type { DiscordAction } from './types';

type Data = { interaction: { id: string; applicationId: string; token: string }; userId: string; discordUserId: string; command?: string; action: DiscordAction };

/**
 * Per source, per reply: wait at most 1.5 s for a rate-limit slot (MusicBrainz
 * allows one request a second for the whole platform) and 8 s in all.
 */
export const LOOKUP_BUDGET = { queueMs: 1500, totalMs: 8000 };
/** The second try, when the first found nothing because every source was busy. */
const PATIENT_BUDGET = { queueMs: 20_000, totalMs: 30_000 };

/** A resolved lookup is reused for an hour, so the buttons don't query every source again. */
const CACHE_TTL_S = 3600;
const cacheKey = (orgId: string, ref: string) => `lc:discord:md:${orgId}:${ref}`;

/** A message for the person, not a failure (no access, nothing found, bad input). */
class Notice extends Error {
  constructor(
    message: string,
    readonly notFound = false,
  ) {
    super(message);
  }
}

type Run = {
  job: JobContext;
  orgId: string;
  access: MemberAccess;
  started: number;
  log: LookupLog;
  reply: (message: MessagePayload, files?: MessageFile[]) => Promise<boolean>;
  /** Run as the member: their permissions and artist scope apply. */
  asMember: <T>(fn: (ctx: ServiceContext) => Promise<T>) => Promise<T>;
};

const appUrl = () => env().APP_URL.replace(/\/$/, '');

function inputKind(action: DiscordAction): string {
  if (action.kind === 'view') return 'button';
  if (action.kind === 'pick' || action.kind === 'pickArtist' || action.kind === 'pickLabel') return 'pick';
  if (action.kind === 'lookup' || action.kind === 'correct') {
    const p = parseInput(action.input);
    return !p ? 'other' : p.kind === 'isrc' || p.kind === 'upc' || p.kind === 'text' ? p.kind : 'link';
  }
  return 'text';
}

/** Run one deferred interaction: re-check access, do the work as the member, edit the reply, log it. */
export async function runInteraction(job: JobContext, data: Data) {
  const started = Date.now();
  const orgId = job.orgId!;
  const log: LookupLog = { userId: data.userId, command: data.command ?? data.action.kind, inputKind: inputKind(data.action), outcome: 'error', ref: null, cached: false, durationMs: 0, coverage: null };
  const reply = (message: MessagePayload, files: MessageFile[] = []) => editOriginal(data.interaction.applicationId, data.interaction.token, message, files);
  try {
    // Access is checked again here: a member can be removed between the click and the job.
    const link = await findLink(orgId, data.discordUserId);
    const access = link && link.userId === data.userId ? await memberAccess(data.userId, orgId) : null;
    if (!link || !access || !access.permissions.has(USE_PERMISSION)) throw new Notice('Your Discord account is no longer linked to a Label Console member who can see the catalogue.');
    await touchLink(link.id);
    const run: Run = {
      job,
      orgId,
      access,
      started,
      log,
      reply,
      asMember: (fn) => withOrg({ orgId, actor: { type: 'user', id: access.user.id, name: access.user.name }, permissions: access.permissions, artistScope: access.artistScope }, fn),
    };
    const a = data.action;
    switch (a.kind) {
      case 'lookup':
      case 'pick':
        return await songCard(run, a);
      case 'view':
        return await viewMessage(run, a.view, a.ref);
      case 'artist':
      case 'pickArtist':
        return await artistCard(run, a);
      case 'label':
      case 'pickLabel':
        return await labelCard(run, a);
      case 'licensor':
        return await licensorCard(run, a.input);
      case 'compare':
        return await compareCard(run, a);
      case 'correct':
        return await suggestCorrection(run, a);
    }
  } catch (err) {
    log.outcome = err instanceof Notice ? (err.notFound ? 'not_found' : 'notice') : 'error';
    const message =
      err instanceof Notice
        ? err.message
        : err instanceof RateLimitedError
          ? 'The music databases are busy right now. Try again in a minute.'
          : err instanceof ProviderError && err.provider === 'discord'
            ? "Discord didn't accept Label Console's reply. Try again, and tell an admin if it keeps happening."
            : err instanceof ProviderError
              ? `A music database didn't answer (${err.provider}). Try again in a minute.`
              : 'Something went wrong in Label Console. Try again in a moment.';
    if (!(err instanceof Notice)) job.log.warn({ err }, 'discord lookup failed');
    await reply(renderNotice(message)).catch((e) => job.log.warn({ err: e }, 'could not edit the Discord reply'));
  } finally {
    log.durationMs = Date.now() - started;
    await job.withOrg((ctx) => recordLookup(ctx, log)).catch((err) => job.log.warn({ err }, 'could not log a Discord lookup'));
  }
}

/* ---------------------------------------------------------- resolving -- */

type Target = { parsed: ParsedInput; raw: string; kind: CardKind };

const isRef = (s: string) => /^(isrc:[A-Z]{2}[A-Z0-9]{3}\d{7}|upc:\d{12,14})$/.test(s);

function fromRef(ref: string): Target {
  if (ref.startsWith('isrc:')) {
    const isrc = normalizeIsrc(ref.slice(5));
    if (isrc) return { parsed: { kind: 'isrc', isrc }, raw: isrc, kind: 'track' };
  }
  if (ref.startsWith('upc:')) {
    const upc = normalizeUpc(ref.slice(4));
    if (upc) return { parsed: { kind: 'upc', upc }, raw: upc, kind: 'release' };
  }
  throw new Notice('That button no longer works. Run the command again.');
}

function fromKey(key: string): Target {
  if (key.startsWith('dz:')) return { parsed: { kind: 'deezer', entity: 'track', id: key.slice(3), url: `https://www.deezer.com/track/${key.slice(3)}` }, raw: key, kind: 'track' };
  if (key.startsWith('dza:')) return { parsed: { kind: 'deezer', entity: 'album', id: key.slice(4), url: `https://www.deezer.com/album/${key.slice(4)}` }, raw: key, kind: 'release' };
  return fromRef(key);
}

const UNSUPPORTED = "That link isn't from a service Label Console reads. Paste a Spotify, Apple Music, Deezer or YouTube link, an ISRC, a UPC, or \"Artist - Title\".";

/** A link, ISRC or UPC (no text search): /compare and /correct need an exact target. */
function exactTarget(input: string, want?: CardKind): Target {
  if (isRef(input)) return fromRef(input);
  const parsed = parseInput(input);
  if (!parsed) throw new Notice(UNSUPPORTED);
  if (parsed.kind === 'text') throw new Notice(`Use a link, ISRC or UPC here, not a name ("${input.slice(0, 60)}").`);
  const album = parsed.kind === 'upc' || ((parsed.kind === 'spotify' || parsed.kind === 'apple' || parsed.kind === 'deezer') && parsed.entity === 'album');
  return { parsed, raw: input, kind: want ?? (album ? 'release' : 'track') };
}

const refOf = (kind: CardKind, md: ResolvedMetadata) => (kind === 'release' ? (md.upc ? `upc:${md.upc}` : null) : md.isrc ? `isrc:${md.isrc}` : null);

type Cached = { kind: CardKind; md: ResolvedMetadata; lookedUpAt: string };

/** Resolve through every configured source, or reuse a recent result for the same ISRC/UPC. */
async function resolved(run: Run, t: Target): Promise<{ kind: CardKind; md: ResolvedMetadata; lookedUpAt: Date; cached: boolean }> {
  const { job, orgId } = run;
  const direct = t.parsed.kind === 'isrc' ? `isrc:${t.parsed.isrc}` : t.parsed.kind === 'upc' ? `upc:${t.parsed.upc}` : null;
  if (direct) {
    const hit = await redis().get(cacheKey(orgId, direct)).catch(() => null);
    if (hit) {
      const c = JSON.parse(hit) as Cached;
      if (c.kind === t.kind) return { kind: c.kind, md: c.md, lookedUpAt: new Date(c.lookedUpAt), cached: true };
    }
  }
  // Keys are decrypted here, in the worker, with the label's system context; provider calls run outside any transaction.
  // A reply answers with what it has: a source with no free request slot within a moment, or slower than the budget, is left out.
  const rctx = { ...(await job.withOrg((ctx) => resolveContext(ctx))), budget: LOOKUP_BUDGET };
  let md: ResolvedMetadata;
  const empty = (m: ResolvedMetadata) => !m.isrc && !m.upc && !m.title && !m.releaseTitle;
  try {
    md = await resolveMetadata(t.parsed, { input: t.raw, via: 'discord' }, rctx);
    // Nothing found while sources were too busy to ask is not "not found": ask again, waiting longer this time.
    if (empty(md) && md.sources.some((x) => x.outcome === 'busy')) md = await resolveMetadata(t.parsed, { input: t.raw, via: 'discord' }, { ...rctx, budget: PATIENT_BUDGET });
  } finally {
    await job.withOrg((ctx) => recordSpotScraperRequests(ctx, rctx.creds.spotscraper)).catch(() => undefined);
  }
  if (empty(md)) {
    if (md.sources.some((x) => x.outcome && DEGRADED.includes(x.outcome))) throw new RateLimitedError(60_000, 'Music databases busy or failing');
    throw new Notice("None of the music databases recognised that. Check the link or code, or try \"Artist - Title\".", true);
  }
  const ref = refOf(t.kind, md);
  const lookedUpAt = new Date();
  run.log.sources = [...(run.log.sources ?? []), ...md.sources.map((x) => ({ source: x.source, outcome: x.outcome ?? (x.ok ? 'answered' : x.skipped ? 'skipped' : x.error === 'no match' ? 'no_match' : 'error'), ms: x.ms ?? null }))];
  if (ref) await redis().set(cacheKey(orgId, ref), JSON.stringify({ kind: t.kind, md, lookedUpAt: lookedUpAt.toISOString() } satisfies Cached), 'EX', CACHE_TTL_S).catch(() => undefined);
  await job
    .withOrg(async (ctx) => {
      await recordEvidence(ctx, md, lookedUpAt);
      if (md.plays && md.isrc) await recordReading(ctx, { isrc: md.isrc, platform: md.plays.platform, source: md.plays.source, count: md.plays.count });
    })
    .catch((err) => job.log.warn({ err }, 'could not keep the lookup evidence'));
  return { kind: t.kind, md, lookedUpAt, cached: false };
}

/**
 * What this member may see of the label's own records, read as the member
 * (their permissions and artist scope apply). Splits, notes, contracts and
 * money never leave the catalogue: only identity, credits and play counts.
 */
async function buildCard(run: Run, kind: CardKind, md: ResolvedMetadata, lookedUpAt: Date, cached: boolean, shared: boolean): Promise<Card> {
  const { access } = run;
  const ref = refOf(kind, md);
  const sharing = shared ? await sharingFor(run.orgId) : null;
  return run.asMember(async (ctx) => {
    const card: Card = {
      kind,
      ref,
      md,
      owned: null,
      credits: null,
      stats: { unavailable: 'Play history is kept for songs in your catalogue that Label Console tracks, and for any song each time it is looked up.' },
      labelName: access.org.name,
      lookedUpAt,
      cached,
      elapsedMs: Date.now() - run.started,
      shared: sharing ? { distributor: sharing.shareDistributor, streams: sharing.shareStreams } : null,
      corrections: ref ? await approvedCorrections(ctx, ref) : [],
    };
    const enabled = await enabledModuleIds(ctx.tx, access.org);
    if (enabled.has('documents') && (md.upc || md.isrc)) {
      const [hit] = await statementDistributors(ctx, { upc: md.upc, isrc: kind === 'track' ? md.isrc : null });
      if (hit) card.statementDistributor = hit;
    }
    if (!ctx.can('catalogue:read')) return card;
    const track = kind === 'track' && md.isrc ? ((await listTracks(ctx, { q: md.isrc })).find((t) => t.isrc === md.isrc) ?? null) : null;
    const listed = md.upc ? ((await listReleases(ctx, { q: md.upc.replace(/^0/, '') })).find((r) => r.upc === md.upc) ?? null) : null;
    // A track of ours released under a different UPC still tells us its release.
    const release = listed ?? (track?.releases[0] ? await getReleaseRow(ctx, track.releases[0].id) : null);
    if (!track && !release) return card;
    const ownRelease: OwnedRelease | null = release
      ? { id: release.id, title: release.title, upc: release.upc, labelName: release.labelName, pLine: release.pLine, cLine: release.cLine, releaseDate: release.releaseDate, distributor: release.distributor, distributorConfidence: release.distributorConfidence == null ? null : Number(release.distributorConfidence) }
      : null;
    card.owned = { trackId: track?.id ?? null, release: ownRelease, url: track ? `${appUrl()}/catalog/tracks/${track.id}` : `${appUrl()}/catalog/releases/${release!.id}` };
    if (!track) return card;
    card.credits = (await getTrack(ctx, track.id)).credits.map((c) => ({ name: c.name, role: c.role }));
    if (!enabled.has('streams')) card.stats = { unavailable: 'Stream tracking is switched off for this label.' };
    else if (!ctx.can('streams:read')) card.stats = { unavailable: "Your role in Label Console doesn't include play counts." };
    else card.stats = { rows: (await playsByTrack(ctx, [track.id])).map((r) => ({ platform: r.platform, total: r.total, plays7d: r.plays7d, asOf: r.asOf })) };
    return card;
  });
}

/** What the card had, for launch metrics (field coverage by kind of evidence). */
function coverage(card: Card): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of ['isrc', 'upc', 'labelName', 'pLine', 'cLine'] as const) out[f] = fieldEvidence(card, f).status;
  out.distributor = distributorEvidence(card).evidence.status;
  out.credits = card.credits?.length ? 'verified' : 'unknown';
  out.streams = card.md.plays || ('rows' in card.stats && card.stats.rows.length) ? 'reported' : 'unknown';
  return out;
}

/* ------------------------------------------------------- song/release -- */

async function songCard(run: Run, a: Extract<DiscordAction, { kind: 'lookup' | 'pick' }>) {
  const shared = Boolean(a.shared);
  let target: Target;
  if (a.kind === 'pick') target = fromKey(a.key);
  else {
    const parsed = parseInput(a.input);
    if (!parsed) throw new Notice(UNSUPPORTED);
    if (parsed.kind === 'text') {
      // With the artist option given, the query is the title as typed.
      const artist = a.artist?.trim() || parsed.artist;
      const title = a.artist?.trim() ? a.input.trim() : parsed.title;
      const release = a.entity === 'release';
      const candidates = release ? await searchReleaseCandidates(title, artist ?? null) : await searchCandidates(title, artist ?? null);
      if (!candidates.length) throw new Notice(`No ${release ? 'release' : 'song'} matches "${a.input.slice(0, 80)}". Try "Artist - Title", or paste a link${release ? ' or UPC' : ' or ISRC'}.`, true);
      const chosen = unambiguousCandidate(candidates, artist ?? null);
      if (!chosen) {
        run.log.outcome = 'picker';
        await run.reply(renderPicker(artist ? `${artist} - ${title}` : title, candidates, { release, shared }));
        return;
      }
      target = fromKey(chosen.key);
    } else target = exactTarget(a.input, a.entity === 'release' ? 'release' : undefined);
  }
  const r = await resolved(run, target);
  const card = await buildCard(run, r.kind, r.md, r.lookedUpAt, r.cached, shared);
  run.log.ref = card.ref;
  run.log.cached = r.cached;
  run.log.coverage = coverage(card);
  await run.reply(renderCard(card));
  run.log.outcome = 'card';
}

/* --------------------------------------------------------------- views -- */

async function viewMessage(run: Run, view: string, ref: string) {
  run.log.ref = ref;
  const r = await resolved(run, fromRef(ref));
  run.log.cached = r.cached;
  const card = await buildCard(run, r.kind, r.md, r.lookedUpAt, r.cached, false);
  if (view === 'credits') {
    let fetched = null;
    if (!card.credits?.length) {
      const rctx = await run.job.withOrg((ctx) => resolveContext(ctx));
      try {
        fetched = await fetchCredits(rctx.creds, card.md);
      } finally {
        await run.job.withOrg((ctx) => recordSpotScraperRequests(ctx, rctx.creds.spotscraper)).catch(() => undefined);
      }
    }
    await run.reply({ content: '', embeds: fitEmbeds([creditsView(card, fetched)]), components: [] });
  } else if (view === 'chart' || view === 'stats') {
    const { series, note } = await chartSeries(run, card);
    const png = await renderChart(series, cardTitle(card));
    await run.reply({ content: '', embeds: fitEmbeds([chartView(card, series, Boolean(png), note)]), components: [] }, png ? [{ name: 'chart.png', contentType: 'image/png', data: png, description: `Play history for ${cardTitle(card)}` }] : []);
  } else if (view === 'links') {
    await run.reply(linksView(card));
  } else if (view === 'audio') {
    await run.reply(audioView(card, await previewLink(card.md)));
  } else if (view === 'details') {
    const refs = historyRefs(card.kind, card.md);
    card.history = await run.asMember((ctx) => evidenceFor(ctx, refs));
    await run.reply(renderView(card, view));
  } else if (view === 'tracks' || view === 'avail') {
    await run.reply(renderView(card, view));
  } else {
    await run.reply(renderCard(card));
  }
  run.log.outcome = 'card';
}

/** The history rows behind a card: the recording, its release, and each UPC a source put it on. */
function historyRefs(kind: CardKind, md: ResolvedMetadata): string[] {
  const upcs = new Set([md.upc, ...(kind === 'track' ? (md.claims ?? []).map((c) => c.upc) : [])].filter((u): u is string => Boolean(u)));
  return [...(kind === 'track' && md.isrc ? [`isrc:${md.isrc}`] : []), ...[...upcs].map((u) => `upc:${u}`)];
}

/** Play history: the label's own daily tracking for its songs, else the readings kept at each lookup. */
async function chartSeries(run: Run, card: Card): Promise<{ series: ChartSeries | null; note: string | null }> {
  if (card.owned?.trackId && 'rows' in card.stats) {
    const trackId = card.owned.trackId;
    const history = await run.asMember((ctx) => trackHistory(ctx, trackId));
    const s = history.series.find((x) => x.platform === 'spotify') ?? history.series[0];
    if (s?.points.length) {
      // Days the platform didn't refresh have no plays figure yet: left out, not drawn as 0.
      const points = s.points.filter((p) => !p.pending && p.day !== s.since).map((p) => ({ at: `${p.day}T00:00:00Z`, value: p.delta, estimated: p.estimated }));
      if (points.length) return { series: { platform: platformLabel(s.platform), source: s.source, kind: 'daily', points }, note: null };
    }
  }
  if (!card.md.isrc) return { series: null, note: null };
  const isrc = card.md.isrc;
  const rows = await run.asMember((ctx) => readingsFor(ctx, isrc));
  if (!rows.length) return { series: null, note: null };
  return {
    series: { platform: 'Spotify', source: rows[rows.length - 1].source, kind: 'readings', points: rows.map((r) => ({ at: r.capturedAt.toISOString(), value: Number(r.count) })) },
    note: rows.length === 1 ? 'One reading so far: the chart starts once the song has been looked up again on another day.' : null,
  };
}

const platformLabel = (p: string) => ({ spotify: 'Spotify', youtube: 'YouTube', youtube_music: 'YouTube Music' })[p] ?? p;

/** A fresh link to Deezer's 30-second preview: its links are signed and expire within about 15 minutes, so the cached one isn't reused. */
async function previewLink(md: ResolvedMetadata): Promise<string | null> {
  const id = md.platformIds.find((p) => p.platform === 'deezer' && p.entity === 'track')?.externalId;
  if (!id || !/^\d+$/.test(id)) return null;
  const fresh = await fetchJson<{ preview?: string }>(`https://api.deezer.com/track/${id}`, { provider: 'deezer', rateLimit: { key: 'deezer', capacity: 50, refillPerSec: 10 }, allow404: true, retries: 1 }).catch(() => null);
  const url = fresh?.preview;
  return url && /^https:\/\/[a-z0-9-]+\.dzcdn\.net\//.test(url) ? url : null;
}

/* -------------------------------------------------------------- artist -- */

async function artistCard(run: Run, a: Extract<DiscordAction, { kind: 'artist' | 'pickArtist' }>) {
  let artist: DeezerArtist | null;
  const query = a.kind === 'artist' ? a.input.trim() : null;
  if (a.kind === 'pickArtist') artist = await deezerArtist(a.key.slice(5));
  else {
    const m = /deezer\.com\/(?:[a-z]{2}\/)?artist\/(\d+)/.exec(a.input);
    if (m) artist = await deezerArtist(m[1]);
    else {
      const results = await searchArtists(a.input);
      const pick = pickArtist(results, a.input);
      if (pick === 'ambiguous') {
        run.log.outcome = 'picker';
        const choices = results.slice(0, 6).map((r) => ({ value: `dzar:${r.id}`, label: r.name, description: [r.nb_fan != null ? `${r.nb_fan.toLocaleString('en-US')} fans on Deezer` : null, r.nb_album != null ? `${r.nb_album} releases` : null].filter(Boolean).join(' · ') }));
        await run.reply(renderChoice(`Several artists match "${a.input.slice(0, 80)}". Which one?`, 'Choose an artist', PICK_IDS.artist, choices, Boolean(a.shared)));
        return;
      }
      artist = pick;
    }
  }
  if (!artist) throw new Notice(`No artist matches "${(query ?? 'that').slice(0, 80)}".`, true);
  const [full, latest, mb] = await Promise.all([deezerArtist(String(artist.id)), deezerArtistReleases(artist.id), musicbrainzArtist(artist.name).catch(() => null)]);
  const found = full ?? artist;
  const works = mb ? await musicbrainzWorks(mb.id).catch(() => ({ total: null, works: [] })) : { total: null, works: [] };
  const { roster, own } = await run.asMember(async (ctx) => {
    const credited = ctx.can('catalogue:read') ? await creditsForName(ctx, found.name) : [];
    const roles = new Map<string, Set<string>>();
    for (const c of credited) roles.set(c.role, (roles.get(c.role) ?? new Set()).add(c.trackId));
    const own = credited.length ? { total: new Set(credited.map((c) => c.trackId)).size, roles: [...roles.entries()].map(([r, ids]): [string, number] => [r, ids.size]).sort((x, y) => y[1] - x[1]).slice(0, 6), songs: [...new Set(credited.map((c) => c.title))].slice(0, 6) } : null;
    if (!ctx.can('people:read')) return { roster: null, own };
    const person = await findArtistByName(ctx, found.name);
    if (!person) return { roster: null, own };
    const releases = ctx.can('catalogue:read') ? (await listReleases(ctx, { artistId: person.id })).length : 0;
    return { roster: { url: `${appUrl()}/people/artists/${person.id}`, releases }, own };
  });
  const links = [found.link ? { platform: 'deezer', url: found.link } : null, mb ? { platform: 'musicbrainz', url: `https://musicbrainz.org/artist/${mb.id}` } : null].filter((x): x is { platform: string; url: string } => x !== null);
  await run.reply(
    renderArtist({
      name: found.name,
      url: found.link ?? null,
      pictureUrl: found.picture_xl ?? found.picture_big ?? null,
      fans: found.nb_fan ?? null,
      albums: found.nb_album ?? null,
      mb: mb ? { country: mb.country ?? null, type: mb.type ?? null, begin: mb['life-span']?.begin ?? null, area: mb.area?.name ?? null, disambiguation: mb.disambiguation || null, url: `https://musicbrainz.org/artist/${mb.id}` } : null,
      roster,
      latest: latest.map((r) => ({ title: r.title, type: r.record_type ?? null, date: r.release_date ?? null, url: r.link ?? null })),
      links,
      credits: { works: works.works, worksTotal: works.total, own },
      shared: Boolean(a.shared),
      labelName: run.access.org.name,
      lookedUpAt: new Date(),
      elapsedMs: Date.now() - run.started,
    }),
  );
  run.log.outcome = 'card';
}

/* --------------------------------------------------------------- label -- */

async function labelCard(run: Run, a: Extract<DiscordAction, { kind: 'label' | 'pickLabel' }>) {
  let mb: MbLabel | null = null;
  let choices: MbLabel[] = [];
  let name: string;
  if (a.kind === 'pickLabel') {
    mb = await musicbrainzLabel(a.key.slice(4));
    if (!mb) throw new Notice('MusicBrainz no longer has that label.', true);
    name = mb.name;
  } else {
    name = a.input.trim();
    const results = await searchLabels(name).catch(() => []);
    const pick = pickLabel(results, name);
    if (pick && pick !== 'ambiguous') mb = pick;
    else choices = results.slice(0, 6);
  }
  const releaseCount = mb ? await labelReleaseCount(mb.id).catch(() => null) : null;
  const catalogue = await run.asMember(async (ctx) => (ctx.can('catalogue:read') ? releasesByLabel(ctx, mb?.name ?? name) : null));
  const verified = (r: { distributor: string | null; distributorConfidence: string | null }) => r.distributor && (r.distributorConfidence == null || Number(r.distributorConfidence) >= 1);
  const message = renderLabel({
    name: mb?.name ?? name,
    mb: mb ? { type: mb.type ?? null, country: mb.country ?? null, labelCode: mb['label-code'] ?? null, begin: mb['life-span']?.begin ?? null, end: mb['life-span']?.end ?? null, area: mb.area?.name ?? null, disambiguation: mb.disambiguation || null, url: `https://musicbrainz.org/label/${mb.id}`, releaseCount } : null,
    catalogue: catalogue ? { total: catalogue.total, releases: catalogue.releases.slice(0, 10).map((r) => ({ title: r.title, releaseDate: r.releaseDate, url: `${appUrl()}/catalog/releases/${r.id}`, distributor: r.distributor })) } : null,
    distributors: [...new Set((catalogue?.releases ?? []).filter(verified).map((r) => r.distributor!))],
    shared: Boolean(a.shared),
    labelName: run.access.org.name,
    lookedUpAt: new Date(),
    elapsedMs: Date.now() - run.started,
  });
  // No exact match on MusicBrainz: show what the label's records say, and offer the near matches.
  if (choices.length) {
    const choice = renderChoice('', 'Did you mean one of these labels on MusicBrainz?', PICK_IDS.label, choices.map((l) => ({ value: `mbl:${l.id}`, label: l.name, description: [l.type, l.country, l.disambiguation].filter(Boolean).join(' · ') })), Boolean(a.shared));
    message.components = [...(message.components ?? []), ...(choice.components ?? [])];
  }
  await run.reply(message);
  run.log.outcome = mb || catalogue?.total ? 'card' : 'not_found';
}

/* ------------------------------------------------------------ licensor -- */

async function licensorCard(run: Run, query: string) {
  const q = query.trim();
  if (q.length < 2) throw new Notice('Type at least two letters of the distributor or licensor.');
  const result = await run.asMember(async (ctx) => {
    if (!ctx.can('catalogue:read')) return null;
    const enabled = await enabledModuleIds(ctx.tx, run.access.org);
    const fromStatements = enabled.has('documents') ? await statementCodesFor(ctx, q) : { distributors: [], codes: [] };
    const statementReleaseIds = [...new Set(fromStatements.codes.map((c) => c.releaseId).filter((x): x is string => Boolean(x)))];
    const statementUpcs = [...new Set(fromStatements.codes.map((c) => c.upc?.replace(/\D/g, '')).filter((x): x is string => Boolean(x)))];
    const releases = await releasesByDistributor(ctx, q, { ids: statementReleaseIds, upcs: statementUpcs });
    const ref = await distributorReference(ctx);
    const fromStatement = (r: { id: string; upc: string | null }) => statementReleaseIds.includes(r.id) || Boolean(r.upc && statementUpcs.some((u) => u === r.upc || `0${u}` === r.upc));
    return { fromStatements, fromStatement, releases, aliases: ref.aliases };
  });
  if (!result) throw new Notice("Your role in Label Console doesn't include the catalogue.");
  const lower = q.toLowerCase();
  const known = result.aliases.find((x) => x.distributor.toLowerCase().includes(lower))?.distributor;
  const name = result.fromStatements.distributors[0]?.name ?? known ?? result.releases.find((r) => r.distributor)?.distributor ?? q;
  await run.reply(
    renderLicensor({
      query: q,
      name,
      releases: result.releases.map((r) => ({ title: r.title, upc: r.upc, releaseDate: r.releaseDate, url: `${appUrl()}/catalog/releases/${r.id}`, how: result.fromStatement(r) ? 'statements' : 'catalogue' })),
      total: result.releases.length,
      statements: result.fromStatements.distributors.reduce((n, d) => n + d.statements, 0),
      patterns: result.aliases.filter((x) => x.distributor.toLowerCase() === name.toLowerCase()).map((x) => x.pattern),
      labelName: run.access.org.name,
      lookedUpAt: new Date(),
      elapsedMs: Date.now() - run.started,
    }),
  );
  run.log.outcome = result.releases.length ? 'card' : 'not_found';
}

/* ------------------------------------------------------------- compare -- */

async function compareCard(run: Run, a: Extract<DiscordAction, { kind: 'compare' }>) {
  const left = await resolved(run, exactTarget(a.first));
  const right = await resolved(run, exactTarget(a.second));
  const dist = (md: ResolvedMetadata) => (md.distributor.name && md.distributor.confidence > 0 ? `${md.distributor.name} (${Math.round(md.distributor.confidence * 100)}%)` : null);
  // Credits belong to recordings: compared for two songs only.
  let credits: [Awaited<ReturnType<typeof fetchCredits>>, Awaited<ReturnType<typeof fetchCredits>>] = [null, null];
  if (left.kind === 'track' && right.kind === 'track') {
    const rctx = await run.job.withOrg((ctx) => resolveContext(ctx));
    try {
      credits = await Promise.all([fetchCredits(rctx.creds, left.md).catch(() => null), fetchCredits(rctx.creds, right.md).catch(() => null)]);
    } finally {
      await run.job.withOrg((ctx) => recordSpotScraperRequests(ctx, rctx.creds.spotscraper)).catch(() => undefined);
    }
  }
  await run.reply(
    renderCompare({ input: a.first, md: left.md, distributor: dist(left.md), credits: credits[0] }, { input: a.second, md: right.md, distributor: dist(right.md), credits: credits[1] }, { labelName: run.access.org.name, lookedUpAt: new Date(), elapsedMs: Date.now() - run.started }),
  );
  run.log.outcome = 'card';
}

/* --------------------------------------------------------- corrections -- */

async function suggestCorrection(run: Run, a: Extract<DiscordAction, { kind: 'correct' }>) {
  const field = CORRECTABLE_FIELDS.find((f) => f.value === a.field);
  if (!field) throw new Notice('Choose what is wrong from the list.');
  const value = a.value.trim();
  if (!value) throw new Notice('Add the correct value.');
  const r = await resolved(run, exactTarget(a.input));
  const ref = refOf(r.kind, r.md) ?? (r.md.isrc ? `isrc:${r.md.isrc}` : r.md.upc ? `upc:${r.md.upc}` : null);
  if (!ref) throw new Notice('That song or release has no ISRC or UPC, so a correction cannot be filed against it.');
  const md = r.md;
  const plain = md as unknown as Record<string, unknown>;
  const current = field.value === 'artists' ? md.artists.join(', ') : field.value === 'distributor' ? md.distributor.name : typeof plain[field.value] === 'string' ? (plain[field.value] as string) : null;
  const subject = (r.kind === 'release' ? md.releaseTitle ?? md.title : md.title ?? md.releaseTitle) ?? ref;
  run.log.ref = ref;
  await run.asMember((ctx) => createCorrection(ctx, { ref, subject, field: field.value, currentValue: current, proposedValue: value, note: a.note ?? null }));
  await run.reply(renderNotice(`Thanks. Your correction to the ${field.name.toLowerCase()} of "${subject}" is waiting for review in Label Console. Nothing changes until someone who can edit the catalogue approves it.`));
  run.log.outcome = 'card';
}
