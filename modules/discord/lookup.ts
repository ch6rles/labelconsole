import './types';
import { memberAccess, type MemberAccess } from '@labelconsole/core/auth';
import { withOrg, type ServiceContext } from '@labelconsole/core/context';
import { env } from '@labelconsole/core/env';
import { ProviderError, RateLimitedError } from '@labelconsole/core/errors';
import { enabledModuleIds } from '@labelconsole/core/modules';
import type { JobContext } from '@labelconsole/core/queue';
import { redis } from '@labelconsole/core/redis';
import type { ResolvedMetadata } from '@labelconsole/catalogue/schema';
import {
  getReleaseRow,
  getTrack,
  listReleases,
  listTracks,
  normalizeIsrc,
  normalizeUpc,
  parseInput,
  recordSpotScraperRequests,
  resolveContext,
  resolveMetadata,
  searchCandidates,
  unambiguousCandidate,
  type ParsedInput,
} from '@labelconsole/catalogue/service';
import { playsByTrack } from '@labelconsole/streams/service';
import { editOriginal } from './protocol/rest';
import { renderCard, renderNotice, renderPicker, type Card, type CardKind, type OwnedRelease, type View } from './render';
import { findLink, touchLink, USE_PERMISSION } from './service';
import type { DiscordAction } from './types';

type Data = { interaction: { id: string; applicationId: string; token: string }; userId: string; discordUserId: string; action: DiscordAction };

/** A resolved lookup is reused for an hour, so switching views does not query every source again. */
const CACHE_TTL_S = 3600;
const cacheKey = (orgId: string, ref: string) => `lc:discord:md:${orgId}:${ref}`;

class Notice extends Error {}

/** Run one deferred interaction: re-check access, resolve, enrich as the member, then edit the reply. */
export async function runInteraction(job: JobContext, data: Data) {
  const orgId = job.orgId!;
  const reply = (message: Parameters<typeof editOriginal>[2]) => editOriginal(data.interaction.applicationId, data.interaction.token, message);
  try {
    // Access is checked again here: a member can be removed between the click and the job.
    const link = await findLink(orgId, data.discordUserId);
    const access = link && link.userId === data.userId ? await memberAccess(data.userId, orgId) : null;
    if (!link || !access || !access.permissions.has(USE_PERMISSION)) throw new Notice('Your Discord account is no longer linked to a Label Console member who can see the catalogue.');
    await touchLink(link.id);

    const target = await target_(job, data.action);
    if ('picker' in target) return void (await reply(target.picker));
    const { kind, md, lookedUpAt } = await resolved(job, target);
    const view: View = data.action.kind === 'view' ? (data.action.view as View) : 'overview';
    const card = await enrich(access, orgId, kind, md, lookedUpAt);
    await reply(renderCard(card, view));
  } catch (err) {
    const message =
      err instanceof Notice
        ? err.message
        : err instanceof RateLimitedError
          ? 'The music databases are busy right now. Try again in a minute.'
          : err instanceof ProviderError
            ? `A music database didn't answer (${err.provider}). Try again in a minute.`
            : 'Something went wrong in Label Console. Try again in a moment.';
    if (!(err instanceof Notice)) job.log.warn({ err }, 'discord lookup failed');
    await reply(renderNotice(message)).catch((e) => job.log.warn({ err: e }, 'could not edit the Discord reply'));
  }
}

type Target = { parsed: ParsedInput; raw: string; kind: CardKind; ref: string | null };

/** Turn the action into something to resolve, or a "Which one?" list when a search is ambiguous. */
async function target_(job: JobContext, action: DiscordAction): Promise<Target | { picker: ReturnType<typeof renderPicker> }> {
  if (action.kind === 'view') return fromRef(action.ref);
  if (action.kind === 'pick') {
    if (action.key.startsWith('dz:')) {
      const id = action.key.slice(3);
      return { parsed: { kind: 'deezer', entity: 'track', id, url: `https://www.deezer.com/track/${id}` }, raw: action.key, kind: 'track', ref: null };
    }
    return fromRef(action.key);
  }
  const parsed = parseInput(action.input);
  if (!parsed) throw new Notice("That link isn't from a service Label Console reads. Paste a Spotify, Apple Music, Deezer or YouTube link, an ISRC, a UPC, or \"Artist - Title\".");
  if (parsed.kind === 'text') {
    // With the artist option given, the query is the title as typed.
    const artist = action.artist?.trim() || parsed.artist;
    const title = action.artist?.trim() ? action.input.trim() : parsed.title;
    const candidates = await searchCandidates(title, artist ?? null);
    job.log.debug({ found: candidates.length }, 'discord search');
    if (!candidates.length) throw new Notice(`No song matches "${truncateQuery(action.input)}". Try "Artist - Title", or paste a link or ISRC.`);
    const chosen = unambiguousCandidate(candidates, artist ?? null);
    if (!chosen) return { picker: renderPicker(artist ? `${artist} - ${title}` : title, candidates) };
    return target_(job, { kind: 'pick', key: chosen.key });
  }
  const release = parsed.kind === 'upc' || ((parsed.kind === 'spotify' || parsed.kind === 'apple' || parsed.kind === 'deezer') && parsed.entity === 'album');
  return { parsed, raw: action.input, kind: release ? 'release' : 'track', ref: parsed.kind === 'isrc' ? `isrc:${parsed.isrc}` : parsed.kind === 'upc' ? `upc:${parsed.upc}` : null };
}

const truncateQuery = (q: string) => (q.length > 80 ? `${q.slice(0, 79)}…` : q);

function fromRef(ref: string): Target {
  if (ref.startsWith('isrc:')) {
    const isrc = normalizeIsrc(ref.slice(5));
    if (isrc) return { parsed: { kind: 'isrc', isrc }, raw: isrc, kind: 'track', ref: `isrc:${isrc}` };
  }
  if (ref.startsWith('upc:')) {
    const upc = normalizeUpc(ref.slice(4));
    if (upc) return { parsed: { kind: 'upc', upc }, raw: upc, kind: 'release', ref: `upc:${upc}` };
  }
  throw new Notice('That button no longer works. Run /song again.');
}

type Cached = { kind: CardKind; md: ResolvedMetadata; lookedUpAt: string };

/** Resolve through every configured source, or reuse a recent result for the same ISRC/UPC. */
async function resolved(job: JobContext, t: Target): Promise<{ kind: CardKind; md: ResolvedMetadata; lookedUpAt: Date }> {
  const orgId = job.orgId!;
  if (t.ref) {
    const hit = await redis().get(cacheKey(orgId, t.ref)).catch(() => null);
    if (hit) {
      const c = JSON.parse(hit) as Cached;
      return { kind: c.kind, md: c.md, lookedUpAt: new Date(c.lookedUpAt) };
    }
  }
  // Keys are decrypted here, in the worker, with the label's system context; provider calls run outside any transaction.
  const rctx = await job.withOrg((ctx) => resolveContext(ctx));
  let md: ResolvedMetadata;
  try {
    md = await resolveMetadata(t.parsed, { input: t.raw, via: 'discord' }, rctx);
  } finally {
    await job.withOrg((ctx) => recordSpotScraperRequests(ctx, rctx.creds.spotscraper)).catch(() => undefined);
  }
  if (!md.isrc && !md.upc && !md.title && !md.releaseTitle) throw new Notice("None of the music databases recognised that. Check the link or code, or try \"Artist - Title\".");
  const kind = t.kind;
  const ref = kind === 'release' ? (md.upc ? `upc:${md.upc}` : null) : md.isrc ? `isrc:${md.isrc}` : null;
  const lookedUpAt = new Date();
  if (ref) await redis().set(cacheKey(orgId, ref), JSON.stringify({ kind, md, lookedUpAt: lookedUpAt.toISOString() } satisfies Cached), 'EX', CACHE_TTL_S).catch(() => undefined);
  return { kind, md, lookedUpAt };
}

/**
 * What this member may see of the label's own records, read as the member
 * (their permissions and artist scope apply). Splits, notes, contracts and
 * money never leave the catalogue: only identity, credits and play counts.
 */
async function enrich(access: MemberAccess, orgId: string, kind: CardKind, md: ResolvedMetadata, lookedUpAt: Date): Promise<Card> {
  const appUrl = env().APP_URL.replace(/\/$/, '');
  const ref = kind === 'release' ? (md.upc ? `upc:${md.upc}` : null) : md.isrc ? `isrc:${md.isrc}` : null;
  const asMember = <T>(fn: (ctx: ServiceContext) => Promise<T>) => withOrg({ orgId, actor: { type: 'user', id: access.user.id, name: access.user.name }, permissions: access.permissions, artistScope: access.artistScope }, fn);

  return asMember(async (ctx) => {
    const base: Card = { kind, ref, md, owned: null, credits: null, stats: { unavailable: 'Play counts are shown for songs in your catalogue that Label Console tracks.' }, labelName: access.org.name, lookedUpAt };
    if (!ctx.can('catalogue:read')) return base;
    const track = kind === 'track' && md.isrc ? ((await listTracks(ctx, { q: md.isrc })).find((t) => t.isrc === md.isrc) ?? null) : null;
    const listed = md.upc ? ((await listReleases(ctx, { q: md.upc.replace(/^0/, '') })).find((r) => r.upc === md.upc) ?? null) : null;
    // A track of ours released under a different UPC still tells us its release.
    const release = listed ?? (track?.releases[0] ? await getReleaseRow(ctx, track.releases[0].id) : null);
    if (!track && !release) return base;

    const ownRelease: OwnedRelease | null = release
      ? { id: release.id, title: release.title, upc: release.upc, labelName: release.labelName, pLine: release.pLine, cLine: release.cLine, releaseDate: release.releaseDate, distributor: release.distributor, distributorConfidence: release.distributorConfidence == null ? null : Number(release.distributorConfidence) }
      : null;
    const url = track ? `${appUrl}/catalog/tracks/${track.id}` : `${appUrl}/catalog/releases/${release!.id}`;
    const card: Card = { ...base, owned: { trackId: track?.id ?? null, release: ownRelease, url } };
    if (!track) return card;

    const detail = await getTrack(ctx, track.id);
    card.credits = detail.credits.map((c) => ({ name: c.name, role: c.role }));
    const enabled = await enabledModuleIds(ctx.tx, access.org);
    if (!enabled.has('streams')) card.stats = { unavailable: 'Stream tracking is switched off for this label.' };
    else if (!ctx.can('streams:read')) card.stats = { unavailable: "Your role in Label Console doesn't include play counts." };
    else {
      const rows = await playsByTrack(ctx, [track.id]);
      card.stats = { rows: rows.map((r) => ({ platform: r.platform, total: r.total, plays7d: r.plays7d, asOf: r.asOf })) };
    }
    return card;
  });
}
