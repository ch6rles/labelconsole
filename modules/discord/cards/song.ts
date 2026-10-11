import type { ResolvedMetadata } from '@labelconsole/catalogue/schema';
import { ButtonStyle, ComponentType, type ActionRow, type Button, type Embed, type MessagePayload } from '../protocol/types';
import { COLOR, displayUpc, escapeMd, fitEmbeds, formatDate, formatElapsed, formatMoment, formatNumber, platformName, RELEASE_TYPES, sourceName, truncate } from './format';
import { distributorLogo } from './logos';

/**
 * The card for a song or release, laid out like a DistroFind card: a small
 * distributor card with its logo, then the main card with a field grid, cover
 * art and buttons. Every value keeps its provenance: markers on the card,
 * the full story behind Extended Info. Nothing is inferred into a fact.
 */

export type CardKind = 'track' | 'release';
export const VIEWS = ['overview', 'details', 'credits', 'tracks', 'links', 'stats', 'chart', 'audio', 'avail', 'correct'] as const;
export type View = (typeof VIEWS)[number];

export type OwnedRelease = { id: string; title: string; upc: string | null; labelName: string | null; pLine: string | null; cLine: string | null; releaseDate: string | null; distributor: string | null; distributorConfidence: number | null };
export type Correction = { field: string; value: string; reviewer: string | null };
export type PlaysRow = { platform: string; total: number; plays7d: number | null; asOf: string };

export type Card = {
  kind: CardKind;
  /** `isrc:<ISRC>` or `upc:<UPC>`; null when the lookup found neither (no buttons that need it then). */
  ref: string | null;
  md: ResolvedMetadata;
  /** The label's own record, when the member may see it. */
  owned: { trackId: string | null; release: OwnedRelease | null; url: string } | null;
  /** Credits from the label's catalogue; null when the song is not in it (or not visible to this member). */
  credits: Array<{ name: string; role: string }> | null;
  stats: { rows: PlaysRow[] } | { unavailable: string };
  labelName: string;
  lookedUpAt: Date;
  /** The label's distributor statements list this release: authorised distributor exports, so verified. */
  statementDistributor?: { name: string; periodEnd: string | null } | null;
  /** Approved corrections for this song or release. */
  corrections?: Correction[];
  /** How long the lookup took, and whether it came from the cache. */
  elapsedMs?: number;
  cached?: boolean;
  /** Set when the card is posted for everyone: what the label allows on shared cards. */
  shared?: { distributor: boolean; streams: boolean } | null;
  /** What each source has said over time (Extended Info only). */
  history?: HistoryRow[];
};

/** One value a source reported, and when Label Console first and last saw it. */
export type HistoryRow = { ref: string; field: string; source: string; value: string; firstSeenAt: Date; lastSeenAt: Date };

const canon = (v: unknown) =>
  String(v ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

/* ------------------------------------------------------------ evidence -- */

export type FieldKey = 'isrc' | 'upc' | 'title' | 'releaseTitle' | 'releaseDate' | 'labelName' | 'pLine' | 'cLine' | 'durationMs';
export const FIELD_NAMES: Record<string, string> = { isrc: 'ISRC', upc: 'UPC', title: 'Title', releaseTitle: 'Release', releaseType: 'Release type', releaseDate: 'Release date', labelName: 'Label', pLine: '℗ line', cLine: '© line', durationMs: 'Duration', artists: 'Artists', catalogNumber: 'Cat. No.', distributor: 'Distributor', credits: 'Credits' };

export type Evidence = { status: 'verified' | 'reported' | 'conflicting' | 'inferred' | 'unknown'; label: string };

const correctionFor = (card: Card, field: string) => card.corrections?.find((c) => c.field === field) ?? null;

/** The value to show for a field: an approved correction wins over the sources, which stay listed in Extended Info. */
export function fieldValue(card: Card, field: FieldKey): string | null {
  const fix = correctionFor(card, field);
  if (fix) return fix.value;
  const v = card.md[field];
  return v == null || v === '' ? null : String(v);
}

/** How sure we are of one field: verified, source-reported, conflicting or unknown. */
export function fieldEvidence(card: Card, field: FieldKey): Evidence {
  const fix = correctionFor(card, field);
  if (fix) return { status: 'verified', label: `Verified · reviewed correction${fix.reviewer ? ` (${fix.reviewer})` : ''}` };
  const value = card.md[field];
  if (value == null || value === '') return { status: 'unknown', label: 'Unknown' };
  const own = card.owned?.release;
  const ownValue = own && (field === 'labelName' || field === 'pLine' || field === 'cLine' || field === 'releaseDate' || field === 'upc') ? own[field] : null;
  if (ownValue && canon(ownValue) === canon(value)) return { status: 'verified', label: 'Verified · matches your catalogue' };
  if (card.md.conflicts.some((c) => c.field === field)) return { status: 'conflicting', label: 'Sources disagree · see Extended Info' };
  const from = card.md.fieldSources?.[field];
  return { status: 'reported', label: from?.length ? `Reported by ${from.map(sourceName).join(', ')}` : 'Source-reported' };
}

/**
 * Stores never publish the distributor, so it is either verified by the
 * label's own records (a reviewed correction, its distributor statements, or a
 * distributor entered or confirmed in the catalogue) or inferred, and says so.
 */
export function distributorEvidence(card: Card): { value: string | null; evidence: Evidence } {
  const fix = correctionFor(card, 'distributor');
  if (fix) return { value: fix.value, evidence: { status: 'verified', label: 'Verified · reviewed correction' } };
  if (card.statementDistributor) return { value: card.statementDistributor.name, evidence: { status: 'verified', label: 'Verified · in your distributor statements' } };
  const own = card.owned?.release;
  if (own?.distributor && (own.distributorConfidence == null || own.distributorConfidence >= 1)) return { value: own.distributor, evidence: { status: 'verified', label: 'Verified · recorded in your catalogue' } };
  const d = card.md.distributor;
  if (d.name && d.confidence > 0) return { value: d.name, evidence: { status: 'inferred', label: `Inferred · ${Math.round(d.confidence * 100)}% confidence, not proof` } };
  return { value: null, evidence: { status: 'unknown', label: 'No source states the distributor' } };
}

/** A short marker after a value on the card; the words are in Extended Info. */
const marker = (e: Evidence) => (e.status === 'verified' ? ' ✓' : e.status === 'conflicting' ? ' ⚠' : '');

/* --------------------------------------------------------------- links -- */

export function platformLinks(card: Card) {
  const want: Array<'track' | 'release'> = card.kind === 'track' ? ['track', 'release'] : ['release'];
  const out: Array<{ platform: string; url: string }> = [];
  for (const entity of want) {
    for (const p of [...card.md.platformIds].filter((x) => x.entity === entity && x.url && /^https:\/\//.test(x.url) && x.url.length <= 512).sort((a, b) => rank(a.platform) - rank(b.platform))) {
      if (!out.some((o) => o.platform === p.platform)) out.push({ platform: p.platform, url: p.url! });
    }
  }
  return out;
}
const LINK_ORDER = ['spotify', 'apple', 'deezer', 'youtube', 'musicbrainz', 'discogs'];
const rank = (p: string) => {
  const i = LINK_ORDER.indexOf(p);
  return i < 0 ? LINK_ORDER.length : i;
};

/**
 * Discogs' API terms ask for this notice, linked to the page the data came
 * from, next to any of its data. Null when nothing shown came from Discogs.
 */
export function discogsCredit(md: ResolvedMetadata): string | null {
  const page = md.platformIds.find((p) => p.platform === 'discogs' && p.url && /^https:\/\/www\.discogs\.com\//.test(p.url))?.url;
  return page ? `[Data provided by Discogs.](${page})` : null;
}

/* ---------------------------------------------------------------- card -- */

export function cardTitle(card: Card) {
  const md = card.md;
  const fixed = correctionFor(card, card.kind === 'release' ? 'releaseTitle' : 'title')?.value;
  return truncate(fixed ?? (card.kind === 'release' ? md.releaseTitle ?? md.title : md.title ?? md.releaseTitle) ?? 'Untitled', 256);
}

export const cardArtists = (card: Card) => correctionFor(card, 'artists')?.value ?? card.md.artists.join(', ');

/** Title, link and cover shared by the card and its detail views. */
export function heading(card: Card): Pick<Embed, 'title' | 'url' | 'thumbnail' | 'color'> {
  const link = platformLinks(card)[0]?.url;
  return {
    title: cardTitle(card),
    ...(link ? { url: link } : {}),
    ...(card.md.artworkUrl && /^https:\/\//.test(card.md.artworkUrl) ? { thumbnail: { url: card.md.artworkUrl } } : {}),
    color: COLOR,
  };
}

export function footer(card: Card, extra?: string): Pick<Embed, 'footer' | 'timestamp'> {
  const time = card.cached ? 'Cached' : card.elapsedMs != null ? `Time: ${formatElapsed(card.elapsedMs)}` : null;
  const parts = ['Label Console', card.labelName, extra, time].filter(Boolean);
  return { footer: { text: truncate(parts.join(' • '), 2048) }, timestamp: card.lookedUpAt.toISOString() };
}

/** Streams to show: Spotify's count from this lookup, else the label's own latest Spotify reading. */
export function streamsCount(card: Card): { count: number; label: string } | null {
  if (card.md.plays) return { count: card.md.plays.count, label: `Spotify plays reported by ${sourceName(card.md.plays.source)}, ${formatMoment(card.md.plays.at)}` };
  const own = 'rows' in card.stats ? card.stats.rows.find((r) => r.platform === 'spotify') : null;
  return own ? { count: own.total, label: `Spotify plays as of ${formatDate(own.asOf) ?? own.asOf} (tracked by Label Console)` } : null;
}

function distributorEmbed(card: Card): Embed | null {
  if (card.shared && !card.shared.distributor) return null;
  const d = distributorEvidence(card);
  const logo = distributorLogo(d.value);
  return {
    title: d.value ? truncate(d.value, 256) : 'Distributor unknown',
    description: `*${d.evidence.label}*`,
    ...(logo ? { thumbnail: { url: logo } } : {}),
    color: COLOR,
    timestamp: card.lookedUpAt.toISOString(),
  };
}

function mainEmbed(card: Card): Embed {
  const md = card.md;
  const show = (field: FieldKey, fmt: (v: string) => string = escapeMd) => {
    const v = fieldValue(card, field);
    return v ? `${fmt(v)}${marker(fieldEvidence(card, field))}` : 'Unknown';
  };
  const artists = cardArtists(card);
  const type = md.releaseType ? RELEASE_TYPES[md.releaseType] ?? md.releaseType : null;
  const lines = [card.kind === 'release' ? [artists ? `by ${escapeMd(artists)}` : null, type].filter(Boolean).join(' | ') : artists ? `by ${escapeMd(artists)}` : ''];
  if (card.owned && !card.shared) lines.push('📁 In your catalogue');
  const fields: NonNullable<Embed['fields']> = [];
  const streams = card.shared && !card.shared.streams ? null : streamsCount(card);
  if (card.kind === 'track') {
    fields.push({ name: '💿 Album', value: truncate(show('releaseTitle'), 1024), inline: true });
    fields.push({ name: '🏷️ Label', value: truncate(show('labelName'), 1024), inline: true });
    fields.push({ name: '🔖 ISRC', value: show('isrc', (v) => v), inline: true });
    fields.push({ name: '📅 Release Date', value: show('releaseDate', (v) => v.slice(0, 10)), inline: true });
    fields.push({ name: '🔢 UPC', value: show('upc', (v) => displayUpc(v) ?? v), inline: true });
    if (streams) fields.push({ name: '📈 Streams', value: formatNumber(streams.count), inline: true });
  } else {
    fields.push({ name: '🏷️ Label', value: truncate(show('labelName'), 1024), inline: true });
    fields.push({ name: '🔢 UPC', value: show('upc', (v) => displayUpc(v) ?? v), inline: true });
    fields.push({ name: '📅 Release Date', value: show('releaseDate', (v) => v.slice(0, 10)), inline: true });
    fields.push({ name: '🎵 Tracks', value: md.tracks.length ? String(md.tracks.length) : 'Unknown', inline: true });
    if (md.catalogNumber) {
      const credit = discogsCredit(md);
      fields.push({ name: '🗂️ Cat. No.', value: `${escapeMd(md.catalogNumber)}${credit ? `\n${credit}` : ''}`, inline: true });
    }
    if (fieldValue(card, 'pLine')) fields.push({ name: '℗ P Line', value: truncate(show('pLine'), 1024) });
    if (fieldValue(card, 'cLine')) fields.push({ name: '© C Line', value: truncate(show('cLine'), 1024) });
  }
  const anyMarker = fields.some((f) => / [✓⚠]$/.test(f.value));
  return {
    ...heading(card),
    description: truncate(lines.filter(Boolean).join('\n'), 4096),
    fields,
    ...footer(card, anyMarker ? '✓ verified · ⚠ sources disagree' : undefined),
  };
}

const button = (label: string, emoji: string, customId: string, style: 1 | 2 | 3 = ButtonStyle.SECONDARY): Button => ({ type: ComponentType.BUTTON, style, label, emoji: { name: emoji }, custom_id: customId });
const linkButton = (label: string, emoji: string, url: string): Button => ({ type: ComponentType.BUTTON, style: ButtonStyle.LINK, label, emoji: { name: emoji }, url });

export const viewId = (view: View, ref: string) => `lc:v:${view}:${ref}`;

/** Wide enough to call "worldwide": Spotify lists about 185 markets, Deezer about 180. */
export const WORLDWIDE = 175;

function buttons(card: Card): ActionRow[] {
  const rows: ActionRow[] = [];
  const ref = card.ref;
  const consoleLink = card.owned && !card.shared && card.owned.url.startsWith('https://') ? linkButton('Open in Label Console', '📁', card.owned.url) : null;
  if (!ref) {
    const links = platformLinks(card).slice(0, consoleLink ? 4 : 5).map((l) => linkButton(platformName(l.platform), '🔗', l.url));
    return links.length || consoleLink ? [{ type: ComponentType.ACTION_ROW, components: [...links, ...(consoleLink ? [consoleLink] : [])] }] : [];
  }
  if (card.kind === 'track') {
    rows.push({ type: ComponentType.ACTION_ROW, components: [button('Extended Info', 'ℹ️', viewId('details', ref)), button('View Credits', '👥', viewId('credits', ref)), button('View Performance Chart', '📈', viewId('chart', ref)), button('Other Links', '🔗', viewId('links', ref))] });
    const second: Button[] = [];
    if (card.md.previewUrl) second.push(button('Audio File', '🎧', viewId('audio', ref)));
    const countries = card.md.availability?.countries.length ?? 0;
    if (countries) second.push(button(countries >= WORLDWIDE ? 'Playable Worldwide' : `Playable in ${countries} ${countries === 1 ? 'country' : 'countries'}`, '🌍', viewId('avail', ref), countries >= WORLDWIDE ? ButtonStyle.SUCCESS : ButtonStyle.SECONDARY));
    second.push(button('Report / Correct', '✏️', viewId('correct', ref)));
    if (consoleLink) second.push(consoleLink);
    rows.push({ type: ComponentType.ACTION_ROW, components: second });
  } else {
    rows.push({ type: ComponentType.ACTION_ROW, components: [button('View Tracklist', '📃', viewId('tracks', ref)), button('Extended Info', 'ℹ️', viewId('details', ref)), button('Other Links', '🔗', viewId('links', ref)), button('Report / Correct', '✏️', viewId('correct', ref))] });
    if (consoleLink) rows.push({ type: ComponentType.ACTION_ROW, components: [consoleLink] });
  }
  return rows;
}

export function renderCard(card: Card): MessagePayload {
  const embeds = [distributorEmbed(card), mainEmbed(card)].filter((e): e is Embed => e !== null);
  return { content: '', embeds: fitEmbeds(embeds), components: buttons(card) };
}
