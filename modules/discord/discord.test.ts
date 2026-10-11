import { generateKeyPairSync, sign } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { ResolvedMetadata } from '@labelconsole/catalogue/schema';
import { songInMessage } from './interactions';
import { commandDefinitions, MESSAGE_COMMAND } from './protocol/commands';
import type { Interaction } from './protocol/types';
import { verifyDiscordSignature } from './protocol/verify';
import { distributorEvidence, embedLength, escapeMd, fieldEvidence, fitEmbed, formatDate, formatDuration, parseCustomId, renderCard, renderPicker, type Card } from './render';
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

  it('follow Discord naming rules', () => {
    for (const c of commandDefinitions()) {
      if (c.type === 1) expect(c.name).toMatch(/^[-_a-z0-9]{1,32}$/);
      else expect('description' in c).toBe(false); // message commands take no description
      if ('description' in c) expect(c.description.length).toBeLessThanOrEqual(100);
    }
    expect(commandDefinitions().map((c) => c.name)).toContain(MESSAGE_COMMAND);
  });
});

describe('custom ids', () => {
  it('round-trip views and picks and refuse anything else', () => {
    expect(parseCustomId('lc:v:credits:isrc:GBDUW0000059', undefined)).toEqual({ kind: 'view', view: 'credits', ref: 'isrc:GBDUW0000059' });
    expect(parseCustomId('lc:v:tracks:upc:0724384960650', undefined)).toEqual({ kind: 'view', view: 'tracks', ref: 'upc:0724384960650' });
    expect(parseCustomId('lc:pick', ['dz:3135556'])).toEqual({ kind: 'pick', key: 'dz:3135556' });
    expect(parseCustomId('lc:pick', ['isrc:GBDUW0000059'])).toEqual({ kind: 'pick', key: 'isrc:GBDUW0000059' });
    expect(parseCustomId('lc:pick', ['https://evil.example'])).toBeNull();
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
  ...over,
});

describe('evidence', () => {
  it('labels each field by how it is known', () => {
    expect(fieldEvidence(card(), 'isrc')).toEqual({ status: 'reported', label: 'Reported by Deezer, MusicBrainz' });
    expect(fieldEvidence(card(), 'releaseDate').status).toBe('conflicting');
    expect(fieldEvidence(card(), 'pLine')).toEqual({ status: 'unknown', label: 'Unknown' });
    const owned = card({ owned: { trackId: 't', url: 'https://console.example/catalog/tracks/t', release: { id: 'r', title: 'Discovery', upc: '0724384960650', labelName: 'Parlophone (France)', pLine: null, cLine: null, releaseDate: '2001-03-07', distributor: null, distributorConfidence: null } } });
    expect(fieldEvidence(owned, 'labelName').status).toBe('verified');
    // The label's own record settles a conflict only when it matches.
    expect(fieldEvidence(owned, 'releaseDate').status).toBe('verified');
  });

  it('never presents an inferred distributor as fact', () => {
    expect(distributorEvidence(card())).toEqual({ value: 'Warner', evidence: { status: 'inferred', label: 'Inferred · 42% confidence, not proof' } });
    const release = { id: 'r', title: 'Discovery', upc: null, labelName: null, pLine: null, cLine: null, releaseDate: null };
    expect(distributorEvidence(card({ owned: { trackId: null, url: 'https://x.example', release: { ...release, distributor: 'Believe', distributorConfidence: 0.7 } } })).evidence.status).toBe('inferred');
    expect(distributorEvidence(card({ owned: { trackId: null, url: 'https://x.example', release: { ...release, distributor: 'Believe', distributorConfidence: 1 } } }))).toMatchObject({ value: 'Believe', evidence: { status: 'verified' } });
    expect(distributorEvidence(card({ md: { ...MD, distributor: { name: null, confidence: 0, evidence: [] } } })).evidence.status).toBe('unknown');
  });
});

describe('cards', () => {
  it('render an overview with artwork, links and one button per view', () => {
    const m = renderCard(card());
    const e = m.embeds![0];
    expect(e.title).toBe('Harder, Better, Faster, Stronger');
    expect(e.url).toBe('https://open.spotify.com/track/5W3cjX2J3tjhG8zb6u0qHn');
    expect(e.thumbnail?.url).toContain('dzcdn');
    expect(e.fields?.map((f) => f.name)).toEqual(['ISRC', 'UPC', 'Label', '© line', 'Distributor']);
    expect(e.footer?.text).toContain('Sources: Deezer, MusicBrainz');
    const [views, links] = m.components!;
    const ids = views.components.map((c) => ('custom_id' in c ? c.custom_id : ''));
    expect(ids).toEqual(['lc:v:overview:isrc:GBDUW0000059', 'lc:v:details:isrc:GBDUW0000059', 'lc:v:credits:isrc:GBDUW0000059', 'lc:v:links:isrc:GBDUW0000059', 'lc:v:stats:isrc:GBDUW0000059']);
    expect(new Set(ids).size).toBe(ids.length);
    expect(links.components.map((c) => ('label' in c ? c.label : ''))).toEqual(['Spotify', 'Deezer', 'MusicBrainz']);
  });

  it('show conflicts and sources in Extended info, and say metadata is not proof of rights', () => {
    const d = renderCard(card(), 'details').embeds![0].description!;
    expect(d).toContain('Deezer "2001-03-07" · MusicBrainz "2001-03-12"');
    expect(d).toContain('Spotify – not used');
    expect(d).toContain('not proof of who owns or licenses');
  });

  it('only link to Label Console on an https address', () => {
    const owned = { trackId: 't', release: null };
    expect(renderCard(card({ owned: { ...owned, url: 'http://localhost:3000/catalog/tracks/t' } })).components!.flatMap((r) => r.components).some((c) => 'label' in c && c.label === 'Open in Label Console')).toBe(false);
    expect(renderCard(card({ owned: { ...owned, url: 'https://console.example/catalog/tracks/t' } })).components![1].components[0]).toMatchObject({ style: 5, label: 'Open in Label Console' });
  });

  it('list credits from the catalogue, and explain when there are none to show', () => {
    expect(renderCard(card({ credits: [{ name: 'Thomas Bangalter', role: 'Producer' }, { name: 'Guy-Manuel de Homem-Christo', role: 'Producer' }] }), 'credits').embeds![0].description).toContain('**Producer:** Thomas Bangalter, Guy-Manuel de Homem-Christo');
    expect(renderCard(card(), 'credits').embeds![0].description).toContain('shown for songs in your catalogue');
  });

  it('describe what play counts are', () => {
    const d = renderCard(card({ stats: { rows: [{ platform: 'spotify', total: 1234567, plays7d: 8910, asOf: '2026-10-10' }] } }), 'stats').embeds![0].description!;
    expect(d).toContain('**Spotify:** 1,234,567 as of 10 Oct 2026 · +8,910 in the last 7 days');
    expect(d).toContain('not a stream count');
  });

  it('give releases a tracklist instead of credits and performance', () => {
    const m = renderCard(card({ kind: 'release', ref: 'upc:0724384960650' }), 'stats');
    expect(m.embeds![0].title).toBe('Discovery');
    expect(m.components![0].components.map((c) => ('label' in c ? c.label : ''))).toEqual(['Overview', 'Extended info', 'Tracklist', 'Other links']);
  });

  it('keep every embed under Discord’s size limits', () => {
    const long = 'x'.repeat(3000);
    const m = renderCard(card({ md: { ...MD, title: long, pLine: long, cLine: long, labelName: long, artists: [long] } }));
    const e = m.embeds![0];
    expect(e.title!.length).toBeLessThanOrEqual(256);
    expect(e.fields!.every((f) => f.value.length <= 1024)).toBe(true);
    expect(embedLength(e)).toBeLessThanOrEqual(6000);
    const big = fitEmbed({ description: 'y'.repeat(4096), fields: [{ name: 'a', value: 'z'.repeat(1024) }, { name: 'b', value: 'z'.repeat(1024) }], footer: { text: 'f'.repeat(1000) } });
    expect(embedLength(big)).toBe(6000);
  });

  it('show source text as text, never as markdown or a mention', () => {
    expect(escapeMd('**Bold** _it_ @everyone [x](y)')).toBe('\\*\\*Bold\\*\\* \\_it\\_ @​everyone \\[x\\](y)');
  });
});

describe('the "Which one?" list', () => {
  const c = (i: number) => ({ key: `dz:${i}`, source: 'deezer' as const, title: `Song ${i}`, artists: ['Artist'], album: 'Album', durationMs: 200000, year: null, explicit: i === 2, exact: false });

  it('offers each candidate with enough detail to choose', () => {
    const m = renderPicker('Song', [c(1), c(2)]);
    expect(m.content).toBe('Several songs match "Song". Which one?');
    const select = m.components![0].components[0];
    expect(select).toMatchObject({ type: 3, custom_id: 'lc:pick' });
    expect('options' in select && select.options).toEqual([
      { label: 'Song 1 — Artist', value: 'dz:1', description: 'Album · 3:20' },
      { label: 'Song 2 — Artist', value: 'dz:2', description: 'Album · 3:20 · Explicit' },
    ]);
  });

  it('asks for confirmation when there is a single near match', () => {
    expect(renderPicker('Sng', [c(1)]).content).toBe('Is this the song you meant by "Sng"?');
  });
});

describe('formatting', () => {
  it('formats dates and durations', () => {
    expect(formatDate('2001-03-07')).toBe('7 Mar 2001');
    expect(formatDate('2001-03')).toBe('Mar 2001');
    expect(formatDate('2001')).toBe('2001');
    expect(formatDuration(224000)).toBe('3:44');
    expect(formatDuration(null)).toBeNull();
  });
});
