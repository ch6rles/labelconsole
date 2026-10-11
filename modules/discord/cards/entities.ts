import type { ResolvedMetadata } from '@labelconsole/catalogue/schema';
import { CORRECTABLE_FIELDS } from '../protocol/commands';
import { ButtonStyle, ComponentType, type ActionRow, type Button, type Embed, type MessagePayload, type Modal } from '../protocol/types';
import { COLOR, countryName, displayUpc, escapeMd, fitEmbeds, flag, formatDate, formatDuration, formatElapsed, formatNumber, listValue, platformName, RELEASE_TYPES, truncate } from './format';
import { distributorLogo } from './logos';

/** Cards for /artist, /label, /licensor and /compare, the "Which one?" lists, and the correction form. */

type Meta = { labelName: string; lookedUpAt: Date; elapsedMs?: number };

const foot = (m: Meta, extra?: string): Pick<Embed, 'footer' | 'timestamp'> => ({
  footer: { text: truncate(['Label Console', m.labelName, extra, m.elapsedMs != null ? `Time: ${formatElapsed(m.elapsedMs)}` : null].filter(Boolean).join(' • '), 2048) },
  timestamp: m.lookedUpAt.toISOString(),
});
const linkButton = (label: string, url: string, emoji?: string): Button => ({ type: ComponentType.BUTTON, style: ButtonStyle.LINK, label: truncate(label, 80), url, ...(emoji ? { emoji: { name: emoji } } : {}) });
const linkRows = (buttons: Button[]): ActionRow[] => {
  const ok = buttons.filter((b) => b.url && /^https:\/\//.test(b.url) && b.url.length <= 512).slice(0, 10);
  const rows: ActionRow[] = [];
  for (let i = 0; i < ok.length; i += 5) rows.push({ type: ComponentType.ACTION_ROW, components: ok.slice(i, i + 5) });
  return rows;
};

/* -------------------------------------------------------------- artist -- */

export type ArtistCard = Meta & {
  name: string;
  url: string | null;
  pictureUrl: string | null;
  fans: number | null;
  albums: number | null;
  mb: { country: string | null; type: string | null; begin: string | null; area: string | null; disambiguation: string | null; url: string } | null;
  roster: { url: string | null; releases: number } | null;
  latest: Array<{ title: string; type: string | null; date: string | null; url: string | null }>;
  links: Array<{ platform: string; url: string }>;
  shared?: boolean;
};

export function renderArtist(a: ArtistCard): MessagePayload {
  const fields: NonNullable<Embed['fields']> = [];
  if (a.fans != null) fields.push({ name: '👥 Fans', value: `${formatNumber(a.fans)}\n*Deezer*`, inline: true });
  if (a.albums != null) fields.push({ name: '💿 Releases', value: `${formatNumber(a.albums)}\n*Deezer*`, inline: true });
  if (a.mb?.country) fields.push({ name: '🌍 Country', value: `${flag(a.mb.country)} ${countryName(a.mb.country)}\n*MusicBrainz*`, inline: true });
  if (a.mb?.type) fields.push({ name: '🏷️ Type', value: escapeMd(a.mb.type), inline: true });
  if (a.mb?.begin) fields.push({ name: '📅 Active since', value: formatDate(a.mb.begin) ?? a.mb.begin, inline: true });
  if (a.mb?.area && a.mb.area !== countryName(a.mb.country ?? '')) fields.push({ name: '📍 From', value: escapeMd(a.mb.area), inline: true });
  if (a.latest.length) fields.push({ name: '🆕 Latest releases', value: listValue(a.latest.map((r) => `• ${r.url ? `[${escapeMd(r.title)}](${r.url})` : escapeMd(r.title)}${[r.type ? RELEASE_TYPES[r.type] ?? r.type : null, r.date ? r.date.slice(0, 4) : null].filter(Boolean).length ? ` — ${[r.type ? RELEASE_TYPES[r.type] ?? r.type : null, r.date ? r.date.slice(0, 4) : null].filter(Boolean).join(', ')}` : ''}`)) });
  const lines = [a.mb?.disambiguation ? `*${escapeMd(a.mb.disambiguation)}*` : null, a.roster && !a.shared ? `📁 On your roster${a.roster.releases ? ` · ${a.roster.releases} release${a.roster.releases === 1 ? '' : 's'} in your catalogue` : ''}` : null].filter(Boolean);
  const embed: Embed = { title: truncate(a.name, 256), ...(a.url ? { url: a.url } : {}), ...(a.pictureUrl ? { thumbnail: { url: a.pictureUrl } } : {}), color: COLOR, ...(lines.length ? { description: lines.join('\n') } : {}), fields, ...foot(a) };
  const buttons = [...(a.roster?.url && !a.shared ? [linkButton('Open in Label Console', a.roster.url, '📁')] : []), ...a.links.map((l) => linkButton(platformName(l.platform), l.url, '🔗'))];
  return { content: '', embeds: fitEmbeds([embed]), components: linkRows(buttons) };
}

/* --------------------------------------------------------------- label -- */

export type LabelCard = Meta & {
  name: string;
  mb: { type: string | null; country: string | null; labelCode: number | null; begin: string | null; end: string | null; area: string | null; disambiguation: string | null; url: string; releaseCount: number | null } | null;
  catalogue: { total: number; releases: Array<{ title: string; releaseDate: string | null; url: string | null; distributor: string | null }> } | null;
  distributors: string[];
  shared?: boolean;
};

export function renderLabel(l: LabelCard): MessagePayload {
  const fields: NonNullable<Embed['fields']> = [];
  if (l.mb?.type) fields.push({ name: '🏷️ Type', value: escapeMd(l.mb.type), inline: true });
  if (l.mb?.country) fields.push({ name: '🌍 Country', value: `${flag(l.mb.country)} ${countryName(l.mb.country)}`, inline: true });
  if (l.mb?.labelCode) fields.push({ name: '🔢 Label code', value: `LC ${String(l.mb.labelCode).padStart(5, '0')}`, inline: true });
  if (l.mb?.begin) fields.push({ name: '📅 Founded', value: `${formatDate(l.mb.begin)}${l.mb.end ? ` – ${formatDate(l.mb.end)}` : ''}`, inline: true });
  if (l.mb?.releaseCount != null) fields.push({ name: '💿 Releases on MusicBrainz', value: formatNumber(l.mb.releaseCount), inline: true });
  if (l.catalogue && !l.shared) {
    fields.push({
      name: `📁 In your catalogue (${l.catalogue.total})`,
      value: l.catalogue.total ? listValue(l.catalogue.releases.map((r) => `• ${r.url?.startsWith('https://') ? `[${escapeMd(r.title)}](${r.url})` : escapeMd(r.title)}${r.releaseDate ? ` — ${formatDate(r.releaseDate)}` : ''}`)) : 'No releases in your catalogue name this label.',
    });
    if (l.distributors.length) fields.push({ name: '🏢 Distributors on your records', value: listValue(l.distributors.map((d) => `• ${escapeMd(d)}`)) });
  }
  const description = [l.mb?.disambiguation ? `*${escapeMd(l.mb.disambiguation)}*` : null, l.mb ? null : '*MusicBrainz has no label by this exact name.*', '*A label credit is not proof of who licenses or distributes a release; see /licensor.*'].filter(Boolean).join('\n');
  const embed: Embed = { title: truncate(l.name, 256), ...(l.mb?.url ? { url: l.mb.url } : {}), color: COLOR, description, fields, ...foot(l, l.mb ? 'Label details from MusicBrainz' : undefined) };
  return { content: '', embeds: fitEmbeds([embed]), components: linkRows(l.mb ? [linkButton('MusicBrainz', l.mb.url, '🔗')] : []) };
}

/* ------------------------------------------------------------ licensor -- */

export type LicensorCard = Meta & {
  query: string;
  name: string;
  releases: Array<{ title: string; upc: string | null; releaseDate: string | null; url: string | null; how: 'statements' | 'catalogue' }>;
  total: number;
  statements: number;
  patterns: string[];
};

export function renderLicensor(c: LicensorCard): MessagePayload {
  const logo = distributorLogo(c.name);
  const fields: NonNullable<Embed['fields']> = [];
  fields.push({
    name: `✓ Verified releases (${c.total})`,
    value: c.total
      ? listValue(c.releases.map((r) => `• ${r.url?.startsWith('https://') ? `[${escapeMd(r.title)}](${r.url})` : escapeMd(r.title)}${r.upc ? ` · \`${displayUpc(r.upc)}\`` : ''} — *${r.how === 'statements' ? 'distributor statements' : 'your catalogue'}*`))
      : 'None of your records verify a release with this distributor or licensor.',
  });
  if (c.statements) fields.push({ name: '📄 Statements', value: `${c.statements} statement${c.statements === 1 ? '' : 's'} from ${escapeMd(c.name)}`, inline: true });
  if (c.patterns.length) fields.push({ name: '🔎 Text that suggests it (not proof)', value: listValue(c.patterns.map((p) => `• "${escapeMd(p)}"`)) });
  const embed: Embed = {
    title: truncate(c.name, 256),
    ...(logo ? { thumbnail: { url: logo } } : {}),
    color: COLOR,
    description: '*Only your own records count as verification: distributor statements and distributors entered or confirmed in your catalogue. A label name or ℗ line is never proof of the licensor.*',
    fields,
    ...foot(c),
  };
  return { content: '', embeds: fitEmbeds([embed]), components: [] };
}

/* ------------------------------------------------------------- compare -- */

export type CompareSide = { input: string; md: ResolvedMetadata; distributor: string | null };

const COMPARE_FIELDS: Array<[string, (m: ResolvedMetadata, d: string | null) => string | null]> = [
  ['Title', (m) => m.title ?? m.releaseTitle],
  ['Artists', (m) => (m.artists.length ? m.artists.join(', ') : null)],
  ['ISRC', (m) => m.isrc],
  ['UPC', (m) => displayUpc(m.upc)],
  ['Release', (m) => m.releaseTitle],
  ['Release date', (m) => m.releaseDate],
  ['Label', (m) => m.labelName],
  ['℗ line', (m) => m.pLine],
  ['© line', (m) => m.cLine],
  ['Distributor (inferred)', (_m, d) => d],
  ['Duration', (m) => formatDuration(m.durationMs)],
  ['Tracks', (m) => (m.tracks.length ? String(m.tracks.length) : null)],
];

const same = (a: string | null, b: string | null) => (a ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim() === (b ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

export function renderCompare(a: CompareSide, b: CompareSide, meta: Meta): MessagePayload {
  const fields: NonNullable<Embed['fields']> = [];
  const differs: string[] = [];
  const matches: string[] = [];
  for (const [name, get] of COMPARE_FIELDS) {
    const x = get(a.md, a.distributor);
    const y = get(b.md, b.distributor);
    if (!x && !y) continue;
    if (same(x, y)) matches.push(`**${name}:** ${escapeMd(truncate(x ?? '', 80))}`);
    else {
      differs.push(name);
      fields.push({ name: `≠ ${name}`, value: truncate(`**1:** ${x ? escapeMd(x) : '—'}\n**2:** ${y ? escapeMd(y) : '—'}`, 1024) });
    }
  }
  if (matches.length) fields.push({ name: '✓ The same', value: listValue(matches) });
  const t = (m: ResolvedMetadata) => escapeMd(truncate(m.title ?? m.releaseTitle ?? 'Untitled', 80));
  const description = [`**1:** ${t(a.md)} · ${escapeMd(truncate(a.md.artists.join(', '), 60))}`, `**2:** ${t(b.md)} · ${escapeMd(truncate(b.md.artists.join(', '), 60))}`, '', differs.length ? `**${differs.length} difference${differs.length === 1 ? '' : 's'}:** ${differs.join(', ')}` : '**No differences in the fields compared.**'].join('\n');
  const embed: Embed = { title: '⚖️ Compare', color: COLOR, description, fields: fields.slice(0, 25), ...foot(meta, 'Values as the sources report them') };
  return { content: '', embeds: fitEmbeds([embed]), components: [] };
}

/* ------------------------------------------------------------- pickers -- */

export type Choice = { value: string; label: string; description?: string | null };

export const PICK_IDS = { song: 'lc:pick', artist: 'lc:pa', label: 'lc:pl' } as const;

/** "Which one?": a list to pick from. `shared` keeps the card public once picked. */
export function renderChoice(question: string, placeholder: string, customId: string, choices: Choice[], shared = false): MessagePayload {
  return {
    content: truncate(question, 2000),
    embeds: [],
    components: [
      {
        type: ComponentType.ACTION_ROW,
        components: [{ type: ComponentType.STRING_SELECT, custom_id: shared ? `${customId}:s` : customId, placeholder: truncate(placeholder, 150), options: choices.slice(0, 25).map((c) => ({ label: truncate(c.label, 100), value: c.value, ...(c.description ? { description: truncate(c.description, 100) } : {}) })) }],
      },
    ],
  };
}

export type PickCandidate = { key: string; title: string; artists: string[]; album: string | null; durationMs: number | null; year: string | null; explicit: boolean | null; source: string; releaseType?: string | null; trackCount?: number | null };

export function renderPicker(query: string, candidates: PickCandidate[], opts: { release?: boolean; shared?: boolean } = {}): MessagePayload {
  const one = candidates.length === 1;
  const noun = opts.release ? 'release' : 'song';
  const choices = candidates.map((c) => ({
    value: c.key,
    label: `${c.title} — ${c.artists.join(', ') || 'Unknown artist'}`,
    description:
      [c.album, c.releaseType ? RELEASE_TYPES[c.releaseType] ?? c.releaseType : null, c.trackCount ? `${c.trackCount} tracks` : null, formatDuration(c.durationMs), c.year, c.explicit ? 'Explicit' : null, c.source === 'musicbrainz' ? 'MusicBrainz' : null].filter(Boolean).join(' · ') || null,
  }));
  return renderChoice(one ? `Is this the ${noun} you meant by "${escapeMd(query)}"?` : `Several ${noun}s match "${escapeMd(query)}". Which one?`, one ? 'Yes, look this one up' : `Choose a ${noun}`, PICK_IDS.song, choices, opts.shared);
}

export function renderNotice(text: string): MessagePayload {
  return { content: truncate(text, 2000), embeds: [], components: [] };
}

/* ---------------------------------------------------------- correction -- */

export const FIX_ID = 'lc:fix';

/** The Report / Correct form: what is wrong, the right value, and where it comes from. */
export function correctionModal(ref: string, title: string): Modal {
  return {
    custom_id: `${FIX_ID}:${ref}`,
    title: truncate(`Correct: ${title}`, 45),
    components: [
      {
        type: ComponentType.LABEL,
        label: 'What is wrong?',
        component: { type: ComponentType.STRING_SELECT, custom_id: 'field', placeholder: 'Choose a field', options: CORRECTABLE_FIELDS.map((f) => ({ label: f.name, value: f.value })) },
      },
      { type: ComponentType.LABEL, label: 'The correct value', component: { type: ComponentType.TEXT_INPUT, custom_id: 'value', style: 1, required: true, max_length: 500 } },
      { type: ComponentType.LABEL, label: 'Where this comes from', description: 'A document, a link, or who confirmed it. Optional.', component: { type: ComponentType.TEXT_INPUT, custom_id: 'note', style: 2, required: false, max_length: 500 } },
    ],
  };
}
