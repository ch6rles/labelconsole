import { generateKeyPairSync, sign } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { ResolvedMetadata } from '@labelconsole/catalogue/schema';
import { chartSvg, compact, renderChart, ticks } from './chart';
import { modalValues, songInMessage } from './interactions';
import { commandDefinitions, CORRECTABLE_FIELDS, MESSAGE_COMMAND } from './protocol/commands';
import type { Button, Embed, Interaction } from './protocol/types';
import { verifyDiscordSignature } from './protocol/verify';
import {
  availabilityView,
  correctionModal,
  creditGroups,
  creditsView,
  chartView,
  detailsView,
  distributorEvidence,
  distributorLogo,
  embedLength,
  escapeMd,
  fieldEvidence,
  fitEmbed,
  fitEmbeds,
  formatDate,
  formatDuration,
  linksView,
  parseCustomId,
  renderCard,
  renderChoice,
  renderCompare,
  renderPicker,
  type Card,
} from './render';
import { hashLinkCode } from './service';

function keys() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const hex = publicKey.export({ format: 'der', type: 'spki' }).subarray(12).toString('hex');
  return { hex, privateKey };
}

describe('request signatures', () => {
  const { hex, privateKey } = keys();
  const body = Buffer.from('{"type":1,"application_id":"123456789012345678"}');
  const ts = '1760000000';
  const sig = sign(null, Buffer.concat([Buffer.from(ts), body]), privateKey).toString('hex');

  it('accepts what Discord signed and nothing else', () => {
    expect(verifyDiscordSignature(hex, sig, ts, body)).toBe(true);
    expect(verifyDiscordSignature(hex.toUpperCase(), sig, ts, body)).toBe(true);
    expect(verifyDiscordSignature(hex, sig, '1760000001', body)).toBe(false);
    expect(verifyDiscordSignature(hex, sig, ts, Buffer.from('{"type":2}'))).toBe(false);
    expect(verifyDiscordSignature(keys().hex, sig, ts, body)).toBe(false);
  });

  it('rejects malformed input without throwing', () => {
    expect(verifyDiscordSignature(hex, sig.slice(2), ts, body)).toBe(false);
    expect(verifyDiscordSignature(hex, `zz${sig.slice(2)}`, ts, body)).toBe(false);
    expect(verifyDiscordSignature('not-a-key', sig, ts, body)).toBe(false);
    expect(verifyDiscordSignature(hex, sig, 'soon', body)).toBe(false);
  });
});

describe('link codes', () => {
  it('ignore case and dashes, and reject anything that cannot be a code', () => {
    expect(hashLinkCode('ABCD-EFGH')).toMatch(/^[0-9a-f]{64}$/);
    expect(hashLinkCode('abcd efgh')).toBe(hashLinkCode('ABCD-EFGH'));
    expect(hashLinkCode('ABCD-EFG')).toBeNull();
    expect(hashLinkCode('ABCD-EFG0')).toBeNull(); // 0 is not in the alphabet
    expect(hashLinkCode('')).toBeNull();
  });
});

describe('commands', () => {
  it('only name the install types the app has on', () => {
    const user = commandDefinitions([1]);
    expect(user.every((c) => c.integration_types.join() === '1' && c.contexts.join() === '0,1,2')).toBe(true);
    const server = commandDefinitions([0]);
    expect(server.every((c) => c.contexts.join() === '0,1')).toBe(true);
  });

  it('cover the plan and follow Discord naming and option rules', () => {
    const all = commandDefinitions();
    expect(all.map((c) => c.name)).toEqual(['song', 'release', 'artist', 'label', 'licensor', 'compare', 'correct', 'link', 'unlink', MESSAGE_COMMAND]);
    for (const c of all) {
      if (c.type === 1) expect(c.name).toMatch(/^[-_a-z0-9]{1,32}$/);
      else expect('description' in c).toBe(false); // message commands take no description
      if ('description' in c) expect(c.description.length).toBeLessThanOrEqual(100);
      const opts = 'options' in c ? (c.options as Array<{ required: boolean; description: string; choices?: unknown[] }>) : [];
      // Required options must come first.
      expect(opts.findIndex((o) => !o.required) === -1 || opts.slice(opts.findIndex((o) => !o.required)).every((o) => !o.required)).toBe(true);
      for (const o of opts) {
        expect(o.description.length).toBeLessThanOrEqual(100);
        expect((o.choices ?? []).length).toBeLessThanOrEqual(25);
      }
    }
    expect(CORRECTABLE_FIELDS.length).toBeLessThanOrEqual(25);
  });
});

describe('custom ids', () => {
  it('round-trip views and picks, keep the shared flag, and refuse anything else', () => {
    expect(parseCustomId('lc:v:credits:isrc:GBDUW0000059', undefined)).toEqual({ kind: 'view', view: 'credits', ref: 'isrc:GBDUW0000059' });
    expect(parseCustomId('lc:v:tracks:upc:0724384960650', undefined)).toEqual({ kind: 'view', view: 'tracks', ref: 'upc:0724384960650' });
    expect(parseCustomId('lc:pick', ['dz:3135556'])).toEqual({ kind: 'pick', key: 'dz:3135556', shared: false });
    expect(parseCustomId('lc:pick:s', ['dza:302127'])).toEqual({ kind: 'pick', key: 'dza:302127', shared: true });
    expect(parseCustomId('lc:pick', ['isrc:GBDUW0000059'])).toEqual({ kind: 'pick', key: 'isrc:GBDUW0000059', shared: false });
    expect(parseCustomId('lc:pa', ['dzar:27'])).toEqual({ kind: 'pickArtist', key: 'dzar:27', shared: false });
    expect(parseCustomId('lc:pl:s', ['mbl:4cd2e3a6-8b2b-4f0e-a0a3-9b1c7a3f1e11'])).toEqual({ kind: 'pickLabel', key: 'mbl:4cd2e3a6-8b2b-4f0e-a0a3-9b1c7a3f1e11', shared: true });
    expect(parseCustomId('lc:pick', ['https://evil.example'])).toBeNull();
    expect(parseCustomId('lc:pa', ['dz:1'])).toBeNull();
    expect(parseCustomId('lc:v:admin:isrc:GBDUW0000059', undefined)).toBeNull();
    expect(parseCustomId('lc:v:overview:isrc:GBDUW0000059;drop', undefined)).toBeNull();
  });
});

describe('Look Up Song', () => {
  const msg = (m: Record<string, unknown>): Interaction => ({ id: '1', application_id: '1', type: 2, token: 't', data: { name: MESSAGE_COMMAND, type: 3, target_id: '9', resolved: { messages: { '9': { id: '9', ...m } } } } });

  it('finds a supported link, then an ISRC or UPC, then short text', () => {
    expect(songInMessage(msg({ content: 'new one!! https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC?si=x.' }))).toBe('https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC?si=x');
    expect(songInMessage(msg({ content: 'see https://example.com/blog and https://music.apple.com/us/album/discovery/697194953' }))).toBe('https://music.apple.com/us/album/discovery/697194953');
    expect(songInMessage(msg({ content: 'isrc is GB-DUW-00-00059 fyi' }))).toBe('GBDUW0000059');
    expect(songInMessage(msg({ content: '', embeds: [{ description: 'UPC 724384960650' }] }))).toBe('0724384960650');
    expect(songInMessage(msg({ content: 'M83 - Midnight City' }))).toBe('M83 - Midnight City');
    expect(songInMessage(msg({ content: 'a long message\nwith several lines' }))).toBeNull();
    expect(songInMessage(msg({ content: 'only https://example.com/nothing-here' }))).toBeNull();
  });

  it('reads a forwarded message from its snapshot', () => {
    expect(songInMessage(msg({ content: '', message_snapshots: [{ message: { content: 'https://www.deezer.com/track/3135556' } }] }))).toBe('https://www.deezer.com/track/3135556');
  });
});

describe('the correction form', () => {
  it('asks for the field, the value and the evidence', () => {
    const m = correctionModal('isrc:GBDUW0000059', 'Report / Correct');
    expect(m.custom_id).toBe('lc:fix:isrc:GBDUW0000059');
    expect(m.title.length).toBeLessThanOrEqual(45);
    expect(m.components.map((c) => [c.type, c.component.type, c.component.custom_id])).toEqual([
      [18, 3, 'field'],
      [18, 4, 'value'],
      [18, 4, 'note'],
    ]);
    expect(m.components.every((c) => c.label.length <= 45)).toBe(true);
  });

  it('reads submissions in the current and the older shape', () => {
    expect(modalValues([{ type: 18, component: { type: 3, custom_id: 'field', values: ['labelName'] } }, { type: 18, component: { type: 4, custom_id: 'value', value: 'Northline' } }])).toEqual({ field: 'labelName', value: 'Northline' });
    expect(modalValues([{ type: 1, components: [{ type: 4, custom_id: 'value', value: 'X' }] }])).toEqual({ value: 'X' });
  });
});

const MD: ResolvedMetadata = {
  input: { input: 'GBDUW0000059' },
  isrc: 'GBDUW0000059',
  upc: '0724384960650',
  title: 'Harder, Better, Faster, Stronger',
  artists: ['Daft Punk'],
  releaseTitle: 'Discovery',
  releaseType: 'album',
  releaseDate: '2001-03-07',
  labelName: 'Parlophone (France)',
  pLine: null,
  cLine: '℗ 2001 Daft Life Ltd.',
  durationMs: 224000,
  explicit: false,
  tracks: [{ title: 'Harder, Better, Faster, Stronger', isrc: 'GBDUW0000059', durationMs: 224000, position: 4, explicit: false, artists: ['Daft Punk'] }],
  platformIds: [
    { platform: 'deezer', entity: 'track', externalId: '3135556', url: 'https://www.deezer.com/track/3135556', source: 'deezer' },
    { platform: 'spotify', entity: 'track', externalId: '5W3cjX2J3tjhG8zb6u0qHn', url: 'https://open.spotify.com/track/5W3cjX2J3tjhG8zb6u0qHn', source: 'spotify' },
    { platform: 'musicbrainz', entity: 'release', externalId: 'rel-1', url: 'https://musicbrainz.org/release/rel-1', source: 'musicbrainz' },
  ],
  distributor: { name: 'Warner', confidence: 0.42, evidence: [{ source: 'catalogue text', signal: 'label', value: 'Parlophone (France)', weight: 0.42, distributor: 'Warner' }] },
  conflicts: [{ field: 'releaseDate', values: [{ source: 'deezer', value: '2001-03-07' }, { source: 'musicbrainz', value: '2001-03-12' }] }],
  sources: [
    { source: 'deezer', ok: true },
    { source: 'musicbrainz', ok: true },
    { source: 'spotify', ok: false, skipped: 'Not connected' },
  ],
  artworkUrl: 'https://cdn-images.dzcdn.net/images/cover/x/1000x1000.jpg',
  fieldSources: { isrc: ['deezer', 'musicbrainz'], labelName: ['deezer'], cLine: ['itunes'] },
  previewUrl: 'https://cdnt-preview.dzcdn.net/api/1/1/a/b/c/0/x.mp3?hdnea=1',
  availability: { source: 'deezer', countries: ['DE', 'FR', 'GB', 'US'] },
  plays: { platform: 'spotify', source: 'spotscraper', count: 306877, at: '2026-10-11T10:00:00Z' },
};

const card = (over: Partial<Card> = {}): Card => ({
  kind: 'track',
  ref: 'isrc:GBDUW0000059',
  md: MD,
  owned: null,
  credits: null,
  stats: { unavailable: 'Not tracked.' },
  labelName: 'Northline',
  lookedUpAt: new Date('2026-10-11T10:00:00Z'),
  elapsedMs: 50,
  ...over,
});
const ownRelease = { id: 'r', title: 'Discovery', upc: '0724384960650', labelName: 'Parlophone (France)', pLine: null, cLine: null, releaseDate: '2001-03-07', distributor: null, distributorConfidence: null };
const buttonsOf = (m: ReturnType<typeof renderCard>) => (m.components ?? []).flatMap((r) => r.components) as Button[];

describe('evidence', () => {
  it('labels each field by how it is known', () => {
    expect(fieldEvidence(card(), 'isrc')).toEqual({ status: 'reported', label: 'Reported by Deezer, MusicBrainz' });
    expect(fieldEvidence(card(), 'releaseDate').status).toBe('conflicting');
    expect(fieldEvidence(card(), 'pLine')).toEqual({ status: 'unknown', label: 'Unknown' });
    const owned = card({ owned: { trackId: 't', url: 'https://console.example/catalog/tracks/t', release: ownRelease } });
    expect(fieldEvidence(owned, 'labelName').status).toBe('verified');
    // The label's own record settles a conflict only when it matches.
    expect(fieldEvidence(owned, 'releaseDate').status).toBe('verified');
    // A reviewed correction wins, and says so.
    expect(fieldEvidence(card({ corrections: [{ field: 'labelName', value: 'Virgin', reviewer: 'Ada' }] }), 'labelName')).toEqual({ status: 'verified', label: 'Verified · reviewed correction (Ada)' });
  });

  it('never presents an inferred distributor as fact', () => {
    expect(distributorEvidence(card())).toEqual({ value: 'Warner', evidence: { status: 'inferred', label: 'Inferred · 42% confidence, not proof' } });
    expect(distributorEvidence(card({ owned: { trackId: null, url: 'https://x.example', release: { ...ownRelease, distributor: 'Believe', distributorConfidence: 0.7 } } })).evidence.status).toBe('inferred');
    expect(distributorEvidence(card({ owned: { trackId: null, url: 'https://x.example', release: { ...ownRelease, distributor: 'Believe', distributorConfidence: 1 } } }))).toMatchObject({ value: 'Believe', evidence: { status: 'verified' } });
    expect(distributorEvidence(card({ statementDistributor: { name: 'DistroKid', periodEnd: '2026-08-31' } }))).toEqual({ value: 'DistroKid', evidence: { status: 'verified', label: 'Verified · in your distributor statements' } });
    expect(distributorEvidence(card({ md: { ...MD, distributor: { name: null, confidence: 0, evidence: [] } } })).evidence.status).toBe('unknown');
  });
});

describe('song cards', () => {
  it('look like a DistroFind card: a distributor card, then the field grid', () => {
    const m = renderCard(card({ statementDistributor: { name: 'DistroKid', periodEnd: null } }));
    const [dist, main] = m.embeds!;
    expect(dist).toMatchObject({ title: 'DistroKid', description: '*Verified · in your distributor statements*', thumbnail: { url: 'https://www.google.com/s2/favicons?domain=distrokid.com&sz=128' } });
    expect(main.title).toBe('Harder, Better, Faster, Stronger');
    expect(main.url).toBe('https://open.spotify.com/track/5W3cjX2J3tjhG8zb6u0qHn');
    expect(main.description).toBe('by Daft Punk');
    expect(main.thumbnail?.url).toContain('dzcdn');
    expect(main.fields?.map((f) => [f.name, f.value, f.inline])).toEqual([
      ['💿 Album', 'Discovery', true],
      ['🏷️ Label', 'Parlophone (France)', true],
      ['🔖 ISRC', 'GBDUW0000059', true],
      ['📅 Release Date', '2001-03-07 ⚠', true],
      ['🔢 UPC', '724384960650', true],
      ['📈 Streams', '306,877', true],
    ]);
    expect(main.footer?.text).toBe('Label Console • Northline • ✓ verified · ⚠ sources disagree • Time: 50ms');
  });

  it('carry the DistroFind buttons, each opening its own reply', () => {
    const b = buttonsOf(renderCard(card()));
    expect(b.map((x) => [x.label, x.emoji?.name, x.custom_id, x.style])).toEqual([
      ['Extended Info', 'ℹ️', 'lc:v:details:isrc:GBDUW0000059', 2],
      ['View Credits', '👥', 'lc:v:credits:isrc:GBDUW0000059', 2],
      ['View Performance Chart', '📈', 'lc:v:chart:isrc:GBDUW0000059', 2],
      ['Other Links', '🔗', 'lc:v:links:isrc:GBDUW0000059', 2],
      ['Audio File', '🎧', 'lc:v:audio:isrc:GBDUW0000059', 2],
      ['Playable in 4 countries', '🌍', 'lc:v:avail:isrc:GBDUW0000059', 2],
      ['Report / Correct', '✏️', 'lc:v:correct:isrc:GBDUW0000059', 2],
    ]);
    const worldwide = buttonsOf(renderCard(card({ md: { ...MD, availability: { source: 'spotify', countries: Array.from({ length: 180 }, (_, i) => `C${i}`) } } })));
    expect(worldwide.find((x) => x.label === 'Playable Worldwide')?.style).toBe(3);
    const ids = b.map((x) => x.custom_id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('link to Label Console only on an https address and never on a shared card', () => {
    const owned = { trackId: 't', release: null };
    expect(buttonsOf(renderCard(card({ owned: { ...owned, url: 'http://localhost:3000/catalog/tracks/t' } }))).some((x) => x.label === 'Open in Label Console')).toBe(false);
    const m = renderCard(card({ owned: { ...owned, url: 'https://console.example/catalog/tracks/t' } }));
    expect(buttonsOf(m).find((x) => x.label === 'Open in Label Console')).toMatchObject({ style: 5, url: 'https://console.example/catalog/tracks/t' });
    expect(m.embeds![1].description).toContain('In your catalogue');
    const shared = renderCard(card({ owned: { ...owned, url: 'https://console.example/catalog/tracks/t' }, shared: { distributor: false, streams: false } }));
    expect(shared.embeds).toHaveLength(1);
    expect(shared.embeds![0].description).not.toContain('In your catalogue');
    expect(shared.embeds![0].fields?.some((f) => f.name.includes('Streams'))).toBe(false);
    expect(buttonsOf(shared).some((x) => x.label === 'Open in Label Console')).toBe(false);
  });

  it('give releases their own grid and a tracklist', () => {
    const m = renderCard(card({ kind: 'release', ref: 'upc:0724384960650', md: { ...MD, pLine: '℗ 2001 Daft Life', catalogNumber: 'VIRGIN 123' } }));
    const main = m.embeds![1];
    expect(main.title).toBe('Discovery');
    expect(main.description).toBe('by Daft Punk | Album');
    expect(main.fields?.map((f) => f.name)).toEqual(['🏷️ Label', '🔢 UPC', '📅 Release Date', '🎵 Tracks', '🗂️ Cat. No.', '℗ P Line', '© C Line']);
    expect(buttonsOf(m).map((x) => x.label)).toEqual(['View Tracklist', 'Extended Info', 'Other Links', 'Report / Correct']);
  });

  it('keep every message under Discord’s size limits', () => {
    const long = 'x'.repeat(3000);
    const m = renderCard(card({ md: { ...MD, title: long, pLine: long, cLine: long, labelName: long, releaseTitle: long, artists: [long] }, kind: 'release' }));
    expect(m.embeds!.reduce((n, e) => n + embedLength(e), 0)).toBeLessThanOrEqual(6000);
    for (const e of m.embeds!) {
      expect(e.title!.length).toBeLessThanOrEqual(256);
      expect((e.fields ?? []).every((f) => f.value.length <= 1024)).toBe(true);
    }
    const big = fitEmbed({ description: 'y'.repeat(4096), fields: [{ name: 'a', value: 'z'.repeat(1024) }, { name: 'b', value: 'z'.repeat(1024) }], footer: { text: 'f'.repeat(1000) } });
    expect(embedLength(big)).toBe(6000);
    const two = fitEmbeds([{ description: 'a'.repeat(4000) }, { description: 'b'.repeat(4000) }] as Embed[]);
    expect(two.reduce((n, e) => n + embedLength(e), 0)).toBeLessThanOrEqual(6000);
  });

  it('show source text as text, never as markdown or a mention', () => {
    expect(escapeMd('**Bold** _it_ @everyone [x](y)')).toBe('\\*\\*Bold\\*\\* \\_it\\_ @​everyone \\[x\\](y)');
  });
});

describe('detail views', () => {
  it('Extended Info shows provenance, conflicts, sources and the rights disclaimer', () => {
    const e = detailsView(card({ md: { ...MD, companies: [{ source: 'discogs', role: 'Distributed By', name: 'EMI' }] } }));
    expect(e.title).toBe('ℹ️ Extended Info');
    const text = JSON.stringify(e);
    expect(text).toContain('Deezer \\"2001-03-07\\" · MusicBrainz \\"2001-03-12\\"');
    expect(text).toContain('Spotify – not used');
    expect(text).toContain('Discogs: Distributed By EMI');
    expect(text).toContain('not proof of who owns or licenses');
  });

  it('Credits are grouped like Spotify’s and say where they came from', () => {
    expect(creditGroups([{ name: 'DJ SENSX', role: 'Main Artist' }, { name: 'Nikita Makarov', role: 'Composer' }, { name: 'Nikita Makarov', role: 'Lyricist' }, { name: 'Ann', role: 'Mastering Engineer' }, { name: 'Bo', role: 'Guitar' }, { name: 'Cy', role: 'Design' }]).map((g) => [g.name, g.credits.length])).toEqual([
      ['Artist', 1],
      ['Composition & Lyrics', 2],
      ['Production & Engineering', 1],
      ['Performers', 1],
      ['Other', 1],
    ]);
    const e = creditsView(card(), { source: 'spotscraper', credits: [{ name: 'DJ SENSX', role: 'Main Artist' }, { name: 'Nikita Makarov', role: 'Composer' }] });
    expect(e.title).toBe('👥 Credits');
    expect(e.fields).toEqual([
      { name: 'Artist', value: '• **DJ SENSX** — Main Artist' },
      { name: 'Composition & Lyrics', value: '• **Nikita Makarov** — Composer' },
    ]);
    expect(e.footer?.text).toContain('Credits from Spotify (SpotScraper)');
    expect(creditsView(card(), null).description).toContain('No credits were found');
  });

  it('Availability lists where a song cannot be played', () => {
    const e = availabilityView(card({ md: { ...MD, availability: { source: 'deezer', countries: ['DE', 'FR'] } } }));
    expect(e.description).toContain('Playable in **2**');
    expect(e.description).toContain('**Available in:** 🇩🇪 Germany, 🇫🇷 France');
  });

  it('Other Links give exact links first and label search links as searches', () => {
    const m = linksView(card());
    const b = buttonsOf(m);
    expect(b.slice(0, 3).map((x) => x.label)).toEqual(['Spotify', 'Deezer', 'MusicBrainz']);
    expect(b.some((x) => x.label === 'YouTube Music (search)')).toBe(true);
    expect(b.every((x) => x.style === 5 && x.url!.startsWith('https://'))).toBe(true);
  });

  it('Performance explains what the numbers are', () => {
    const e = chartView(card(), { platform: 'Spotify', source: 'spotscraper', kind: 'readings', points: [{ at: '2026-10-01T10:00:00Z', value: 300000 }, { at: '2026-10-11T10:00:00Z', value: 306877 }] }, true, null);
    expect(e.image?.url).toBe('attachment://chart.png');
    expect(JSON.stringify(e.fields)).toContain('+6,877');
    expect(e.description).toContain('nothing between readings is filled in');
  });
});

describe('the performance chart', () => {
  it('draws bars for daily plays and a line for readings, without filling gaps', () => {
    const daily = chartSvg({ platform: 'Spotify', source: 'spotscraper', kind: 'daily', points: [{ at: '2026-10-01T00:00:00Z', value: 10 }, { at: '2026-10-02T00:00:00Z', value: 20, estimated: true }, { at: '2026-10-05T00:00:00Z', value: 15 }] }, 'Song');
    expect(daily.match(/<rect /g)).toHaveLength(4); // background + three bars, nothing for the missing days
    expect(daily).toContain('opacity="0.45"');
    const readings = chartSvg({ platform: 'Spotify', source: 'spotscraper', kind: 'readings', points: [{ at: '2026-10-01T10:00:00Z', value: 100 }, { at: '2026-10-02T10:00:00Z', value: 150 }, { at: '2026-10-09T10:00:00Z', value: 400 }] }, 'Song <&>');
    expect(readings).toContain('stroke-dasharray'); // a week apart: drawn as a gap
    expect(readings).toContain('Song &lt;&amp;&gt;');
  });

  it('renders a PNG', async () => {
    const png = await renderChart({ platform: 'Spotify', source: 'spotscraper', kind: 'readings', points: [{ at: '2026-10-01T10:00:00Z', value: 100 }, { at: '2026-10-02T10:00:00Z', value: 150 }] }, 'Song');
    expect(png?.subarray(1, 4).toString()).toBe('PNG');
    expect(await renderChart({ platform: 'Spotify', source: 's', kind: 'readings', points: [{ at: '2026-10-01T10:00:00Z', value: 1 }] }, 'Song')).toBeNull();
  });

  it('labels the axis with round numbers', () => {
    expect(ticks(0, 95)).toEqual([0, 25, 50, 75, 100]);
    expect(compact(306877)).toBe('307K');
    expect(compact(1_250_000)).toBe('1.3M');
  });
});

describe('lists, comparisons and logos', () => {
  const c = (i: number) => ({ key: `dz:${i}`, source: 'deezer' as const, title: `Song ${i}`, artists: ['Artist'], album: 'Album', durationMs: 200000, year: null, explicit: i === 2, exact: false });

  it('offer each candidate with enough detail to choose', () => {
    const m = renderPicker('Song', [c(1), c(2)]);
    expect(m.content).toBe('Several songs match "Song". Which one?');
    const select = m.components![0].components[0];
    expect(select).toMatchObject({ type: 3, custom_id: 'lc:pick' });
    expect('options' in select && select.options).toEqual([
      { label: 'Song 1 — Artist', value: 'dz:1', description: 'Album · 3:20' },
      { label: 'Song 2 — Artist', value: 'dz:2', description: 'Album · 3:20 · Explicit' },
    ]);
    expect(renderPicker('Sng', [c(1)], { release: true, shared: true }).content).toBe('Is this the release you meant by "Sng"?');
    expect(renderChoice('?', 'Pick', 'lc:pa', [{ value: 'dzar:1', label: 'A' }], true).components![0].components[0]).toMatchObject({ custom_id: 'lc:pa:s' });
  });

  it('compare two songs field by field', () => {
    const m = renderCompare({ input: 'a', md: MD, distributor: 'Warner (42%)' }, { input: 'b', md: { ...MD, upc: '0724384960651', labelName: 'Virgin' }, distributor: 'Warner (42%)' }, { labelName: 'Northline', lookedUpAt: new Date() });
    const e = m.embeds![0];
    expect(e.description).toContain('**2 differences:** UPC, Label');
    expect(e.fields?.map((f) => f.name)).toEqual(['≠ UPC', '≠ Label', '✓ The same']);
  });

  it('find a logo for known distributors', () => {
    expect(distributorLogo('The Orchard')).toContain('theorchard.com');
    expect(distributorLogo('DistroKid Ltd')).toContain('distrokid.com');
    expect(distributorLogo('Unknown Co')).toBeNull();
  });

  it('format dates and durations', () => {
    expect(formatDate('2001-03-07')).toBe('7 Mar 2001');
    expect(formatDate('2001-03')).toBe('Mar 2001');
    expect(formatDate('2001')).toBe('2001');
    expect(formatDuration(224000)).toBe('3:44');
    expect(formatDuration(null)).toBeNull();
  });
});
