import { ButtonStyle, ComponentType, type ActionRow, type Button, type Embed, type MessagePayload } from '../protocol/types';
import { COUNTRIES, countryName, displayUpc, escapeMd, fitEmbeds, flag, formatDate, formatDuration, formatNumber, listValue, platformName, RELEASE_TYPES, sourceName, truncate } from './format';
import { cardArtists, cardTitle, distributorEvidence, FIELD_NAMES, fieldEvidence, fieldValue, footer, heading, platformLinks, streamsCount, WORLDWIDE, type Card, type FieldKey } from './song';

/**
 * The message each card button opens: its own private reply, so the card
 * stays as it was (like the Credits reply in a DistroFind thread).
 */

const subtitle = (card: Card) => {
  const link = heading(card).url;
  const title = escapeMd(cardTitle(card));
  const artists = cardArtists(card);
  return `${link ? `[${title}](${link})` : `**${title}**`}${artists ? ` · ${escapeMd(artists)}` : ''}`;
};

const view = (card: Card, title: string, body: Partial<Embed>, footerExtra?: string): Embed => {
  const h = heading(card);
  return { title, ...(h.thumbnail ? { thumbnail: h.thumbnail } : {}), color: h.color, description: truncate([subtitle(card), body.description].filter(Boolean).join('\n\n'), 4096), ...(body.fields ? { fields: body.fields } : {}), ...(body.image ? { image: body.image } : {}), ...footer(card, footerExtra) };
};

/* ------------------------------------------------------- Extended Info -- */

export function detailsView(card: Card): Embed {
  const md = card.md;
  const line = (k: FieldKey, fmt: (v: string) => string = escapeMd) => {
    const v = fieldValue(card, k);
    return `**${FIELD_NAMES[k]}:** ${v ? fmt(v) : 'Unknown'} — *${fieldEvidence(card, k).label}*`;
  };
  const fields: NonNullable<Embed['fields']> = [];
  const ids = [line('isrc', (v) => `\`${v}\``), line('upc', (v) => `\`${displayUpc(v) ?? v}\``)];
  if (md.catalogNumber) ids.push(`**Cat. No.:** ${escapeMd(md.catalogNumber)} — *Reported by Discogs*`);
  for (const p of md.platformIds) ids.push(`**${platformName(p.platform)} ${p.entity}:** \`${escapeMd(p.externalId)}\``);
  fields.push({ name: '🔖 Identifiers', value: listValue(ids) });

  const rel = [line('releaseTitle'), line('releaseDate', (v) => formatDate(v) ?? v)];
  if (md.releaseType) rel.push(`**Type:** ${RELEASE_TYPES[md.releaseType] ?? md.releaseType}`);
  if (md.tracks.length) rel.push(`**Tracks:** ${md.tracks.length}`);
  if (card.kind === 'track') {
    const d = formatDuration(md.durationMs);
    if (d) rel.push(`**Duration:** ${d}`);
    if (md.explicit != null) rel.push(`**Explicit:** ${md.explicit ? 'Yes' : 'No'}`);
  }
  fields.push({ name: '💿 Release', value: listValue(rel) });
  fields.push({ name: '🏷️ Label and rights', value: listValue([line('labelName'), line('pLine'), line('cLine')]) });

  const d = distributorEvidence(card);
  const dist = [`**Distributor:** ${d.value ? escapeMd(d.value) : 'Unknown'} — *${d.evidence.label}*`];
  if (d.evidence.status === 'inferred') for (const e of md.distributor.evidence.slice(0, 3)) dist.push(`↳ ${escapeMd(e.source)}: ${escapeMd(e.signal)} "${escapeMd(truncate(e.value, 60))}" suggests ${escapeMd(e.distributor)}`);
  for (const c of (md.companies ?? []).filter((x) => /distributed|licensed|marketed|phonographic|copyright/i.test(x.role)).slice(0, 6)) dist.push(`${sourceName(c.source)}: ${escapeMd(c.role)} ${escapeMd(c.name)}`);
  fields.push({ name: '🏢 Distributor and licensor', value: listValue(dist) });

  const streams = card.shared && !card.shared.streams ? null : streamsCount(card);
  if (streams) fields.push({ name: '📈 Streams', value: `${formatNumber(streams.count)} — *${streams.label}*` });
  if (md.conflicts.length) fields.push({ name: '⚠ Where sources disagree', value: listValue(md.conflicts.map((c) => `**${FIELD_NAMES[c.field] ?? c.field}:** ${c.values.map((v) => `${sourceName(v.source)} "${escapeMd(truncate(v.value, 60))}"`).join(' · ')}`)) });
  if (card.corrections?.length) fields.push({ name: '✓ Reviewed corrections', value: listValue(card.corrections.map((c) => `**${FIELD_NAMES[c.field] ?? c.field}:** ${escapeMd(c.value)}${c.reviewer ? ` (approved by ${escapeMd(c.reviewer)})` : ''}`)) });
  const status = md.sources.map((s) => `${sourceName(s.source)} ${s.ok ? '✓' : s.skipped ? '– not used' : '✗ no answer'}`);
  if (status.length) fields.push({ name: '🔎 Sources checked', value: listValue([status.join(' · ')]) });
  return view(card, 'ℹ️ Extended Info', { description: '*Catalogue metadata is not proof of who owns or licenses a recording.*', fields });
}

/* ------------------------------------------------------------- Credits -- */

const CATEGORIES: Array<[string, RegExp]> = [
  ['Artist', /artist|featur|vocal(ist)?$|^vocals?$|performer$/i],
  ['Composition & Lyrics', /compos|lyric|writer|songwriter|author|words|music by|arrang|publisher/i],
  ['Production & Engineering', /produc|engineer|mix|master|record|programm|edit/i],
  ['Performers', /guitar|bass|drum|piano|keys|keyboard|synth|violin|cello|percussion|saxophone|trumpet|vocals|backing|choir|instrument/i],
];

export function creditGroups(credits: Array<{ name: string; role: string }>) {
  const groups = new Map<string, Array<{ name: string; role: string }>>();
  for (const c of credits) {
    const cat = CATEGORIES.find(([, re]) => re.test(c.role))?.[0] ?? 'Other';
    groups.set(cat, [...(groups.get(cat) ?? []), c]);
  }
  return [...CATEGORIES.map(([n]) => n), 'Other'].filter((n) => groups.has(n)).map((n) => ({ name: n, credits: groups.get(n)! }));
}

export function creditsView(card: Card, fetched: { source: string; credits: Array<{ name: string; role: string }> } | null): Embed {
  const list = card.credits?.length ? { source: 'catalogue', credits: card.credits } : fetched;
  if (!list?.credits.length) {
    const artists = card.md.artists.length ? `\n\n**Artists (as the sources list them):** ${card.md.artists.map(escapeMd).join(', ')}` : '';
    return view(card, '👥 Credits', { description: `No credits were found for this song.${card.credits ? ' It is in your catalogue, but no credits have been added there yet.' : ''}${artists}` });
  }
  const fields = creditGroups(list.credits).map((g) => ({ name: g.name, value: listValue(g.credits.map((c) => `• **${escapeMd(c.name)}** — ${escapeMd(c.role)}`)) }));
  return view(card, '👥 Credits', { fields: fields.slice(0, 25) }, `Credits from ${sourceName(list.source)}`);
}

/* --------------------------------------------------------- Performance -- */

export type ChartSeries = { platform: string; source: string; points: Array<{ at: string; value: number; estimated?: boolean }>; kind: 'daily' | 'readings' };

export function chartView(card: Card, series: ChartSeries | null, hasImage: boolean, note: string | null): Embed {
  const fields: NonNullable<Embed['fields']> = [];
  const streams = streamsCount(card);
  if (streams) fields.push({ name: '📈 Latest count', value: `${formatNumber(streams.count)}\n*${streams.label}*`, inline: true });
  if (series?.points.length) {
    const pts = series.points;
    if (series.kind === 'readings' && pts.length >= 2) {
      const [a, b] = pts.slice(-2);
      fields.push({ name: '↗ Since the previous reading', value: `${b.value - a.value >= 0 ? '+' : ''}${formatNumber(b.value - a.value)}\n*${formatDate(a.at.slice(0, 10))} → ${formatDate(b.at.slice(0, 10))}, calculated*`, inline: true });
    }
    if (series.kind === 'daily') {
      const week = pts.slice(-7);
      const sum = week.reduce((n, p) => n + p.value, 0);
      fields.push({ name: '📅 Last 7 days', value: `${formatNumber(sum)}\n*${week.some((p) => p.estimated) ? 'includes estimated days' : 'daily plays, calculated'}*`, inline: true });
    }
    fields.push({ name: '🗓️ History', value: `${pts.length} ${series.kind === 'daily' ? 'days' : 'readings'} from ${formatDate(pts[0].at.slice(0, 10))}`, inline: true });
  }
  const description = [
    hasImage ? null : series?.points.length ? null : 'No history yet. Label Console keeps a reading each time this song is looked up, and tracks daily plays for songs in your catalogue.',
    note,
    series?.kind === 'readings' ? '*Each point is a count the platform reported when someone looked the song up; nothing between readings is filled in.*' : series?.kind === 'daily' ? '*Daily plays from Label Console’s own tracking. Days the platform did not refresh are spread evenly and marked as estimated.*' : null,
    '*Spotify popularity is not a stream count and is not shown.*',
  ]
    .filter(Boolean)
    .join('\n');
  return view(card, '📈 Performance', { description, fields, ...(hasImage ? { image: { url: 'attachment://chart.png' } } : {}) });
}

/* --------------------------------------------------------- Other links -- */

const searchLink = (base: string, q: string) => `${base}${encodeURIComponent(q)}`;

export function linksView(card: Card): MessagePayload {
  const exact = platformLinks(card);
  const q = [cardArtists(card).split(',')[0], cardTitle(card)].filter(Boolean).join(' ');
  const searches = [
    !exact.some((l) => l.platform === 'apple') ? { platform: 'Apple Music', url: searchLink('https://music.apple.com/search?term=', q) } : null,
    { platform: 'YouTube Music', url: searchLink('https://music.youtube.com/search?q=', q) },
    { platform: 'Tidal', url: searchLink('https://tidal.com/search?q=', q) },
    { platform: 'Amazon Music', url: searchLink('https://music.amazon.com/search/', q) },
    { platform: 'SoundCloud', url: searchLink('https://soundcloud.com/search?q=', q) },
  ].filter((x): x is { platform: string; url: string } => x !== null && x.url.length <= 512);
  const lines = [...exact.map((l) => `**${platformName(l.platform)}:** ${l.url}`), ...(searches.length ? ['', '*Search links (no exact match is known for these):*', ...searches.map((s) => `${s.platform}: ${s.url}`)] : [])];
  const btns: Button[] = [...exact.map((l) => ({ type: ComponentType.BUTTON, style: ButtonStyle.LINK, label: platformName(l.platform), url: l.url }) as Button), ...searches.map((s) => ({ type: ComponentType.BUTTON, style: ButtonStyle.LINK, label: `${s.platform} (search)`, url: s.url }) as Button)].slice(0, 10);
  const rows: ActionRow[] = [];
  for (let i = 0; i < btns.length; i += 5) rows.push({ type: ComponentType.ACTION_ROW, components: btns.slice(i, i + 5) });
  return { content: '', embeds: fitEmbeds([view(card, '🔗 Other Links', { description: lines.join('\n') || 'No platform links were found.' })]), components: rows };
}

/* -------------------------------------------------------- Availability -- */

export function availabilityView(card: Card): Embed {
  const a = card.md.availability;
  if (!a?.countries.length) return view(card, '🌍 Availability', { description: 'No source said where this song can be played.' });
  const have = new Set(a.countries);
  const missing = COUNTRIES.filter((c) => !have.has(c));
  const n = a.countries.length;
  const lines = [`Playable in **${n}** ${n === 1 ? 'country' : 'countries and territories'}, according to ${sourceName(a.source)}.${n >= WORLDWIDE ? ' That is effectively worldwide.' : ''}`];
  if (missing.length && missing.length <= 60) lines.push('', `**Not available in:** ${missing.map((c) => `${flag(c)} ${countryName(c)}`).join(', ')}`);
  else lines.push('', `**Available in:** ${a.countries.map((c) => `${flag(c)} ${countryName(c)}`).join(', ')}`);
  return view(card, '🌍 Availability', { description: lines.join('\n') }, `Markets from ${sourceName(a.source)}`);
}

/* ----------------------------------------------------------- Tracklist -- */

export function tracklistView(card: Card): Embed {
  const rows = card.md.tracks.map((t) => {
    const bits = [formatDuration(t.durationMs), t.isrc ? `\`${t.isrc}\`` : null].filter(Boolean);
    return `**${t.position}.** ${escapeMd(t.title)}${bits.length ? ` — ${bits.join(' · ')}` : ''}`;
  });
  return view(card, '📃 Tracklist', { description: rows.length ? listValue(rows, 3800) : 'No source listed the tracks.' });
}

/* --------------------------------------------------------------- Audio -- */

export function audioView(card: Card, attached: boolean): MessagePayload {
  if (!attached) return { content: 'No preview is available for this song.', embeds: [], components: [] };
  return { content: '', embeds: [view(card, '🎧 Audio File', { description: '30-second preview from Deezer.' })], components: [] };
}

export function renderView(card: Card, kind: 'details' | 'tracks' | 'avail'): MessagePayload {
  const embed = kind === 'details' ? detailsView(card) : kind === 'tracks' ? tracklistView(card) : availabilityView(card);
  return { content: '', embeds: fitEmbeds([embed]), components: [] };
}
