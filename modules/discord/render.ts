import type { ResolvedMetadata } from '@labelconsole/catalogue/schema';
import type { SearchCandidate } from '@labelconsole/catalogue/service';
import { ButtonStyle, ComponentType, type ActionRow, type Button, type Embed, type MessagePayload } from './protocol/types';

/**
 * Pure rendering: a resolved lookup (plus what the member may see of the
 * label's own records) becomes a Discord message. Every value says where it
 * came from; nothing is inferred into a fact.
 */

export type CardKind = 'track' | 'release';
export const VIEWS = ['overview', 'details', 'credits', 'tracks', 'links', 'stats'] as const;
export type View = (typeof VIEWS)[number];

export type OwnedRelease = { id: string; title: string; upc: string | null; labelName: string | null; pLine: string | null; cLine: string | null; releaseDate: string | null; distributor: string | null; distributorConfidence: number | null };

export type Card = {
  kind: CardKind;
  /** `isrc:<ISRC>` or `upc:<UPC>`; null when the lookup found neither (no view buttons then). */
  ref: string | null;
  md: ResolvedMetadata;
  /** The label's own record, when the member may see it. */
  owned: { trackId: string | null; release: OwnedRelease | null; url: string } | null;
  /** Credits from the label's catalogue; null when the song is not in it (or not visible to this member). */
  credits: Array<{ name: string; role: string }> | null;
  stats: { rows: Array<{ platform: string; total: number; plays7d: number | null; asOf: string }> } | { unavailable: string };
  labelName: string;
  lookedUpAt: Date;
};

const COLOR = 0x3b5bdb;
const SOURCE_NAMES: Record<string, string> = {
  spotify: 'Spotify',
  spotscraper: 'Spotify (SpotScraper)',
  apple: 'Apple Music',
  itunes: 'iTunes',
  deezer: 'Deezer',
  musicbrainz: 'MusicBrainz',
  licensed: 'licensed provider',
  tags: 'file tags',
  search: 'search',
  youtube: 'YouTube',
};
const PLATFORM_NAMES: Record<string, string> = { spotify: 'Spotify', apple: 'Apple Music', deezer: 'Deezer', youtube: 'YouTube', youtube_music: 'YouTube Music', musicbrainz: 'MusicBrainz' };
const LINK_ORDER = ['spotify', 'apple', 'deezer', 'youtube', 'musicbrainz'];

export const sourceName = (s: string) => SOURCE_NAMES[s] ?? s;
const platformName = (p: string) => PLATFORM_NAMES[p] ?? p.charAt(0).toUpperCase() + p.slice(1);

/* ---------------------------------------------------------- formatting -- */

export function truncate(s: string, max: number) {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

/** Text from a source shown as text, never as Discord markdown or a mention. */
export function escapeMd(s: string) {
  return s.replace(/([\\*_~`|>[\]])/g, '\\$1').replace(/^([#-])/gm, '\\$1').replace(/@/g, '@\u200b');
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export function formatDate(d: string | null | undefined) {
  if (!d) return null;
  const m = /^(\d{4})(?:-(\d{2}))?(?:-(\d{2}))?/.exec(d);
  if (!m) return d;
  if (!m[2]) return m[1];
  if (!m[3]) return `${MONTHS[Number(m[2]) - 1]} ${m[1]}`;
  return `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]} ${m[1]}`;
}

export function formatDuration(ms: number | null | undefined) {
  if (!ms || ms <= 0) return null;
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

const formatNumber = (n: number) => n.toLocaleString('en-US');
const displayUpc = (upc: string | null | undefined) => (upc ? (upc.length === 13 && upc.startsWith('0') ? upc.slice(1) : upc) : null);
const RELEASE_TYPES: Record<string, string> = { single: 'Single', ep: 'EP', album: 'Album', compilation: 'Compilation' };

/* ------------------------------------------------------------ evidence -- */

type FieldKey = 'isrc' | 'upc' | 'title' | 'releaseTitle' | 'releaseDate' | 'labelName' | 'pLine' | 'cLine' | 'durationMs';
const FIELD_NAMES: Record<FieldKey, string> = { isrc: 'ISRC', upc: 'UPC', title: 'Title', releaseTitle: 'Release', releaseDate: 'Release date', labelName: 'Label', pLine: '℗ line', cLine: '© line', durationMs: 'Duration' };

const canon = (v: unknown) =>
  String(v ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

export type Evidence = { status: 'verified' | 'reported' | 'conflicting' | 'inferred' | 'unknown'; label: string };

/** How sure we are of one field: the PDF's verified / source-reported / conflicting / inferred / unknown. */
export function fieldEvidence(card: Card, field: FieldKey): Evidence {
  const value = card.md[field];
  if (value == null || value === '') return { status: 'unknown', label: 'Unknown' };
  const own = card.owned?.release;
  const ownValue = own && (field === 'labelName' || field === 'pLine' || field === 'cLine' || field === 'releaseDate' || field === 'upc') ? own[field] : null;
  if (ownValue && canon(ownValue) === canon(value)) return { status: 'verified', label: 'Verified · matches your catalogue' };
  if (card.md.conflicts.some((c) => c.field === field)) return { status: 'conflicting', label: 'Sources disagree · see Details' };
  const from = card.md.fieldSources?.[field];
  return { status: 'reported', label: from?.length ? `Reported by ${from.map(sourceName).join(', ')}` : 'Source-reported' };
}

/** The distributor is never published by stores: it is either recorded by the label or inferred. */
export function distributorEvidence(card: Card): { value: string; evidence: Evidence } {
  const own = card.owned?.release;
  if (own?.distributor && (own.distributorConfidence == null || own.distributorConfidence >= 1)) {
    return { value: own.distributor, evidence: { status: 'verified', label: 'Verified · recorded in your catalogue' } };
  }
  const d = card.md.distributor;
  if (d.name && d.confidence > 0) return { value: d.name, evidence: { status: 'inferred', label: `Inferred · ${Math.round(d.confidence * 100)}% confidence, not proof` } };
  return { value: 'Unknown', evidence: { status: 'unknown', label: 'No source states the distributor' } };
}

const fieldValue = (value: string, e: Evidence) => truncate(`${value}\n*${e.label}*`, 1024);

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
const rank = (p: string) => {
  const i = LINK_ORDER.indexOf(p);
  return i < 0 ? LINK_ORDER.length : i;
};

/* --------------------------------------------------------------- views -- */

export function viewsFor(kind: CardKind): View[] {
  return kind === 'track' ? ['overview', 'details', 'credits', 'links', 'stats'] : ['overview', 'details', 'tracks', 'links'];
}

const VIEW_LABELS: Record<View, string> = { overview: 'Overview', details: 'Extended info', credits: 'Credits', tracks: 'Tracklist', links: 'Other links', stats: 'Performance' };

function heading(card: Card): Pick<Embed, 'title' | 'url' | 'author' | 'thumbnail' | 'color'> {
  const md = card.md;
  const title = (card.kind === 'release' ? md.releaseTitle ?? md.title : md.title ?? md.releaseTitle) ?? 'Untitled';
  const link = platformLinks(card)[0]?.url;
  return {
    title: truncate(title, 256),
    ...(link ? { url: link } : {}),
    ...(md.artists.length ? { author: { name: truncate(md.artists.join(', '), 256) } } : {}),
    ...(md.artworkUrl && /^https:\/\//.test(md.artworkUrl) ? { thumbnail: { url: md.artworkUrl } } : {}),
    color: COLOR,
  };
}

function footer(card: Card): Pick<Embed, 'footer' | 'timestamp'> {
  const ok = card.md.sources.filter((s) => s.ok).map((s) => sourceName(s.source));
  const conflicts = card.md.conflicts.length;
  const parts = [ok.length ? `Sources: ${ok.join(', ')}` : 'No source answered', conflicts ? `${conflicts} conflict${conflicts === 1 ? '' : 's'}` : null, card.labelName].filter(Boolean);
  return { footer: { text: truncate(parts.join(' · '), 2048) }, timestamp: card.lookedUpAt.toISOString() };
}

function overview(card: Card): Embed {
  const md = card.md;
  const lines: string[] = [];
  if (card.kind === 'track') {
    const rel = [md.releaseTitle ? `From **${escapeMd(md.releaseTitle)}**` : null, md.releaseType ? RELEASE_TYPES[md.releaseType] ?? md.releaseType : null, formatDate(md.releaseDate)].filter(Boolean);
    if (rel.length) lines.push(rel.join(' · '));
    const meta = [formatDuration(md.durationMs), md.explicit ? 'Explicit' : null].filter(Boolean);
    if (meta.length) lines.push(meta.join(' · '));
  } else {
    const rel = [md.releaseType ? RELEASE_TYPES[md.releaseType] ?? md.releaseType : 'Release', md.tracks.length ? `${md.tracks.length} track${md.tracks.length === 1 ? '' : 's'}` : null, formatDate(md.releaseDate)].filter(Boolean);
    lines.push(rel.join(' · '));
  }
  if (card.owned) lines.push(`**In your catalogue**${card.owned.url.startsWith('https://') ? ` · [open in Label Console](${card.owned.url})` : ''}`);

  const fields: NonNullable<Embed['fields']> = [];
  if (card.kind === 'track') fields.push({ name: 'ISRC', value: fieldValue(md.isrc ? `\`${md.isrc}\`` : 'Unknown', fieldEvidence(card, 'isrc')), inline: true });
  fields.push({ name: 'UPC', value: fieldValue(md.upc ? `\`${displayUpc(md.upc)}\`` : 'Unknown', fieldEvidence(card, 'upc')), inline: true });
  fields.push({ name: 'Label', value: fieldValue(md.labelName ? escapeMd(md.labelName) : 'Unknown', fieldEvidence(card, 'labelName')), inline: true });
  if (md.pLine) fields.push({ name: '℗ line', value: fieldValue(escapeMd(md.pLine), fieldEvidence(card, 'pLine')) });
  if (md.cLine) fields.push({ name: '© line', value: fieldValue(escapeMd(md.cLine), fieldEvidence(card, 'cLine')) });
  const dist = distributorEvidence(card);
  fields.push({ name: 'Distributor', value: fieldValue(escapeMd(dist.value), dist.evidence) });
  return { ...heading(card), description: truncate(lines.join('\n'), 4096), fields, ...footer(card) };
}

function details(card: Card): Embed {
  const md = card.md;
  const lines: string[] = [];
  const keys: FieldKey[] = card.kind === 'track' ? ['title', 'isrc', 'releaseTitle', 'upc', 'releaseDate', 'labelName', 'pLine', 'cLine', 'durationMs'] : ['releaseTitle', 'upc', 'releaseDate', 'labelName', 'pLine', 'cLine'];
  for (const k of keys) {
    const v = md[k];
    const shown = v == null || v === '' ? 'Unknown' : k === 'durationMs' ? formatDuration(v as number) ?? 'Unknown' : k === 'upc' ? displayUpc(String(v)) : k === 'releaseDate' ? formatDate(String(v)) : escapeMd(String(v));
    lines.push(`**${FIELD_NAMES[k]}:** ${shown} — *${fieldEvidence(card, k).label}*`);
  }
  const dist = distributorEvidence(card);
  lines.push(`**Distributor:** ${escapeMd(dist.value)} — *${dist.evidence.label}*`);
  if (dist.evidence.status === 'inferred') {
    for (const e of md.distributor.evidence.slice(0, 3)) lines.push(`↳ ${escapeMd(e.source)}: ${escapeMd(e.signal)} "${escapeMd(truncate(e.value, 60))}" suggests ${escapeMd(e.distributor)}`);
  }
  if (md.conflicts.length) {
    lines.push('', '**Where sources disagree**');
    for (const c of md.conflicts.slice(0, 6)) lines.push(`${FIELD_NAMES[c.field as FieldKey] ?? c.field}: ${c.values.map((v) => `${sourceName(v.source)} "${escapeMd(truncate(v.value, 80))}"`).join(' · ')}`);
  }
  const ids = md.platformIds.filter((p) => p.entity === (card.kind === 'track' ? 'track' : 'release'));
  if (ids.length) lines.push('', `**Platform IDs:** ${ids.map((p) => `${platformName(p.platform)} \`${escapeMd(p.externalId)}\``).join(' · ')}`);
  const status = md.sources.map((s) => `${sourceName(s.source)} ${s.ok ? '✓' : s.skipped ? '– not used' : '✗ no answer'}`);
  if (status.length) lines.push('', `**Sources checked:** ${status.join(' · ')}`);
  lines.push('', '*Catalogue metadata is not proof of who owns or licenses a recording.*');
  return { ...heading(card), description: truncate(lines.join('\n'), 4096), ...footer(card) };
}

function credits(card: Card): Embed {
  let description: string;
  if (card.credits?.length) {
    const byRole = new Map<string, string[]>();
    for (const c of card.credits) byRole.set(c.role, [...(byRole.get(c.role) ?? []), c.name]);
    description = [...byRole].map(([role, names]) => `**${escapeMd(role)}:** ${names.map(escapeMd).join(', ')}`).join('\n') + '\n\n*From your catalogue.*';
  } else if (card.credits) {
    description = 'This song is in your catalogue, but no credits have been added yet.';
  } else {
    const artists = card.md.artists.length ? `\n\n**Artists (as the sources list them):** ${card.md.artists.map(escapeMd).join(', ')}` : '';
    description = `Credits are shown for songs in your catalogue. This one isn't, or your role can't see it.${artists}`;
  }
  return { ...heading(card), description: truncate(description, 4096), ...footer(card) };
}

function tracklist(card: Card): Embed {
  const rows = card.md.tracks.map((t) => {
    const bits = [formatDuration(t.durationMs), t.isrc ? `\`${t.isrc}\`` : null].filter(Boolean);
    return `${t.position}. ${escapeMd(t.title)}${bits.length ? ` — ${bits.join(' · ')}` : ''}`;
  });
  let description = rows.length ? '' : 'No source listed the tracks.';
  for (const [i, r] of rows.entries()) {
    if (description.length + r.length + 40 > 4000) {
      description += `\n…and ${rows.length - i} more`;
      break;
    }
    description += (description ? '\n' : '') + r;
  }
  return { ...heading(card), description, ...footer(card) };
}

function links(card: Card): Embed {
  const list = platformLinks(card);
  const description = list.length ? list.map((l) => `**${platformName(l.platform)}:** ${l.url}`).join('\n') : 'No platform links were found.';
  return { ...heading(card), description: truncate(description, 4096), ...footer(card) };
}

function stats(card: Card): Embed {
  let description: string;
  if ('unavailable' in card.stats) description = card.stats.unavailable;
  else if (!card.stats.rows.length) description = 'Label Console tracks this song, but has no readings yet.';
  else {
    const lines = card.stats.rows.map((r) => {
      const week = r.plays7d != null ? ` · ${r.plays7d >= 0 ? '+' : ''}${formatNumber(r.plays7d)} in the last 7 days` : '';
      return `**${platformName(r.platform)}:** ${formatNumber(r.total)} as of ${formatDate(r.asOf)}${week}`;
    });
    description = `${lines.join('\n')}\n\n*All-time counts are what each platform last reported. The 7-day change is calculated by Label Console from its daily readings. Spotify popularity is not a stream count and is not shown.*`;
  }
  return { ...heading(card), description: truncate(description, 4096), ...footer(card) };
}

const RENDER: Record<View, (card: Card) => Embed> = { overview, details, credits, tracks: tracklist, links, stats };

export function customIdForView(view: View, ref: string) {
  return `lc:v:${view}:${ref}`;
}

function components(card: Card, view: View): ActionRow[] {
  const rows: ActionRow[] = [];
  if (card.ref) {
    const ref = card.ref;
    rows.push({
      type: ComponentType.ACTION_ROW,
      components: viewsFor(card.kind).map((v): Button => ({ type: ComponentType.BUTTON, style: v === view ? ButtonStyle.PRIMARY : ButtonStyle.SECONDARY, label: VIEW_LABELS[v], custom_id: customIdForView(v, ref), disabled: v === view })),
    });
  }
  const linkButtons: Button[] = [];
  if (card.owned?.url.startsWith('https://')) linkButtons.push({ type: ComponentType.BUTTON, style: ButtonStyle.LINK, label: 'Open in Label Console', url: card.owned.url });
  for (const l of platformLinks(card)) {
    if (linkButtons.length >= 5) break;
    linkButtons.push({ type: ComponentType.BUTTON, style: ButtonStyle.LINK, label: platformName(l.platform), url: l.url });
  }
  if (linkButtons.length) rows.push({ type: ComponentType.ACTION_ROW, components: linkButtons });
  return rows;
}

/** Discord limits the text of all embeds in a message to 6000 characters together. */
export const EMBED_TOTAL_MAX = 6000;

export const embedLength = (e: Embed) =>
  (e.title?.length ?? 0) + (e.description?.length ?? 0) + (e.footer?.text.length ?? 0) + (e.author?.name.length ?? 0) + (e.fields ?? []).reduce((n, f) => n + f.name.length + f.value.length, 0);

/** Shorten the description, then the longest fields, until the embed fits. */
export function fitEmbed(e: Embed, max = EMBED_TOTAL_MAX): Embed {
  let over = embedLength(e) - max;
  if (over <= 0) return e;
  const out: Embed = { ...e, fields: e.fields?.map((f) => ({ ...f })) };
  if (out.description) {
    const cut = Math.min(over, Math.max(0, out.description.length - 1));
    if (cut > 0) {
      out.description = truncate(out.description, out.description.length - cut);
      over -= cut;
    }
  }
  for (const f of [...(out.fields ?? [])].sort((a, b) => b.value.length - a.value.length)) {
    if (over <= 0) break;
    const cut = Math.min(over, Math.max(0, f.value.length - 1));
    f.value = truncate(f.value, f.value.length - cut);
    over -= cut;
  }
  return out;
}

export function renderCard(card: Card, view: View = 'overview'): MessagePayload {
  const v = viewsFor(card.kind).includes(view) ? view : 'overview';
  return { content: '', embeds: [fitEmbed(RENDER[v](card))], components: components(card, v) };
}

/* -------------------------------------------------------------- picker -- */

export const PICK_ID = 'lc:pick';

export function renderPicker(query: string, candidates: SearchCandidate[]): MessagePayload {
  const one = candidates.length === 1;
  const options = candidates.slice(0, 25).map((c) => {
    const detail = [c.album, formatDuration(c.durationMs), c.year, c.explicit ? 'Explicit' : null, c.source === 'musicbrainz' ? 'MusicBrainz' : null].filter(Boolean).join(' · ');
    return { label: truncate(`${c.title} — ${c.artists.join(', ') || 'Unknown artist'}`, 100), value: c.key, ...(detail ? { description: truncate(detail, 100) } : {}) };
  });
  return {
    content: truncate(one ? `Is this the song you meant by "${escapeMd(query)}"?` : `Several songs match "${escapeMd(query)}". Which one?`, 2000),
    embeds: [],
    components: [{ type: ComponentType.ACTION_ROW, components: [{ type: ComponentType.STRING_SELECT, custom_id: PICK_ID, placeholder: one ? 'Yes, look this one up' : 'Choose a song', options }] }],
  };
}

export function renderNotice(text: string): MessagePayload {
  return { content: truncate(text, 2000), embeds: [], components: [] };
}

/** Read a component's custom_id back into an action. */
export function parseCustomId(customId: string, values: string[] | undefined): { kind: 'pick'; key: string } | { kind: 'view'; view: View; ref: string } | null {
  if (customId === PICK_ID) {
    const key = values?.[0] ?? '';
    return /^(dz:\d{1,20}|isrc:[A-Z]{2}[A-Z0-9]{3}\d{7})$/.test(key) ? { kind: 'pick', key } : null;
  }
  const m = /^lc:v:([a-z]+):((?:isrc:[A-Z]{2}[A-Z0-9]{3}\d{7})|(?:upc:\d{12,14}))$/.exec(customId);
  if (!m || !(VIEWS as readonly string[]).includes(m[1])) return null;
  return { kind: 'view', view: m[1] as View, ref: m[2] };
}
