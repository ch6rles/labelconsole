import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProviderError, RateLimitedError } from '@labelconsole/core/errors';
import { redis } from '@labelconsole/core/redis';
import type { ResolvedMetadata } from '@labelconsole/catalogue/schema';
import { BREAKER, classify, pausedFor, recordFailure, recordSuccess, resumeSource } from '@labelconsole/catalogue/metadata/breaker';
import { parseInput } from '@labelconsole/catalogue/metadata/input';
import { mergeResults, resolveMetadata } from '@labelconsole/catalogue/metadata/resolve';
import { unambiguousCandidate, type SearchCandidate } from '@labelconsole/catalogue/metadata/search';
import { scoreBenchmark } from './benchmark';
import { songInMessage } from './interactions';
import { audioView, compareCredits, detailsView, discogsCredit, distributorEvidence, historyChanges, renderCard, type Card } from './render';
import { evidenceRows, retentionDays, sourceHealth } from './service';

/**
 * The plan's acceptance criteria (§11, "Testing and acceptance criteria"),
 * one test per row, plus the reliability and evidence rules behind them.
 */

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const DZ_TRACK = { id: 3135556, title: 'Harder, Better, Faster, Stronger', isrc: 'GBDUW0000059', duration: 224, link: 'https://www.deezer.com/track/3135556', artist: { name: 'Daft Punk' }, album: { id: 302127, title: 'Discovery' } };
const DZ_ALBUM = { id: 302127, title: 'Discovery', upc: '724384960650', artist: { name: 'Daft Punk' }, label: 'Parlophone (France)', release_date: '2001-03-07', record_type: 'album', tracks: { data: [{ id: 3135556, title: 'Harder, Better, Faster, Stronger', duration: 224 }] } };
const CTX = { creds: {}, aliases: [], hints: [], scope: 'acceptance-tests' };

let calls: string[] = [];
function stub(handler: (url: string) => Response | Promise<Response> | null) {
  calls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const u = String(url);
      calls.push(u);
      return (await handler(u)) ?? json({ error: { type: 'DataException', message: 'no data', code: 800 } });
    }),
  );
}

/**
 * Breaker state is shared through Redis with every test running at the same
 * time, so these tests only trip label-keyed sources under a scope of their
 * own, or made-up sources: never a shared source another test relies on.
 */
const scope = () => `acceptance-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

afterEach(() => vi.unstubAllGlobals());

const md = (over: Partial<ResolvedMetadata> = {}): ResolvedMetadata => ({
  input: {},
  isrc: 'GBDUW0000059',
  upc: '0724384960650',
  title: 'Harder, Better, Faster, Stronger',
  artists: ['Daft Punk'],
  releaseTitle: 'Discovery',
  releaseType: 'album',
  releaseDate: '2001-03-07',
  labelName: 'Parlophone (France)',
  pLine: null,
  cLine: null,
  durationMs: 224000,
  explicit: false,
  tracks: [],
  platformIds: [],
  distributor: { name: null, confidence: 0, evidence: [] },
  conflicts: [],
  sources: [],
  ...over,
});
const card = (over: Partial<Card> = {}): Card => ({ kind: 'track', ref: 'isrc:GBDUW0000059', md: md(), owned: null, credits: null, stats: { unavailable: 'x' }, labelName: 'Northline', lookedUpAt: new Date('2026-10-11T10:00:00Z'), ...over });
const candidate = (c: Partial<SearchCandidate>): SearchCandidate => ({ key: 'dz:1', source: 'deezer', title: 'Song', artists: ['A'], album: null, durationMs: null, year: null, explicit: null, exact: false, ...c });

describe('plan §11: acceptance', () => {
  it('Exact ISRC: returns the matching recording, with source evidence', async () => {
    stub((u) => (u.startsWith('https://api.deezer.com/track/isrc:GBDUW0000059') ? json(DZ_TRACK) : u.startsWith('https://api.deezer.com/album/302127') ? json(DZ_ALBUM) : null));
    const r = await resolveMetadata({ kind: 'isrc', isrc: 'GBDUW0000059' }, { input: 'GBDUW0000059' }, CTX);
    expect(r).toMatchObject({ isrc: 'GBDUW0000059', title: 'Harder, Better, Faster, Stronger', upc: '0724384960650' });
    expect(r.fieldSources?.isrc).toEqual(['deezer']);
    expect(r.sources.find((s) => s.source === 'deezer')).toMatchObject({ ok: true, outcome: 'answered' });
    expect(r.claims?.find((c) => c.source === 'deezer')).toMatchObject({ upc: '0724384960650', url: 'https://www.deezer.com/track/3135556', values: { labelName: 'Parlophone (France)' } });
    // An exact identifier never goes through a text search.
    expect(calls.some((c) => c.includes('/search'))).toBe(false);
  });

  it('Exact UPC/EAN: returns that release, not a similarly named album', async () => {
    stub((u) => (u.startsWith('https://api.deezer.com/album/upc:724384960650') ? json(DZ_ALBUM) : null));
    const r = await resolveMetadata({ kind: 'upc', upc: '0724384960650' }, { input: '724384960650' }, CTX);
    expect(r).toMatchObject({ upc: '0724384960650', releaseTitle: 'Discovery' });
    expect(calls.some((c) => c.includes('/search'))).toBe(false);
    expect(parseInput('724384960651')?.kind).toBe('text'); // a bad check digit is not taken as a UPC
  });

  it('Same title, different artists: shows candidates, and selects only when the evidence is strong', () => {
    const two = [candidate({ key: 'dz:1', title: 'Hold On', artists: ['Adele'], exact: true }), candidate({ key: 'dz:2', title: 'Hold On', artists: ['Justin Bieber'], exact: true })];
    expect(unambiguousCandidate(two, null)).toBeNull();
    const named = [candidate({ key: 'dz:1', title: 'Hold On', artists: ['Adele'], exact: true }), candidate({ key: 'dz:2', title: 'Hold On', artists: ['Justin Bieber'], exact: false })];
    expect(unambiguousCandidate(named, 'Adele')?.key).toBe('dz:1');
  });

  it('Remix / sped-up / slowed / clean version: distinct recordings are not merged', () => {
    const versions = [candidate({ key: 'dz:1', title: 'Song', exact: true }), candidate({ key: 'dz:2', title: 'Song (Sped Up)' }), candidate({ key: 'dz:3', title: 'Song (Slowed + Reverb)' }), candidate({ key: 'dz:4', title: 'Song (Clean)' })];
    // Without an artist, several results mean the person chooses.
    expect(unambiguousCandidate(versions, null)).toBeNull();
    // With one, only the plain title is an exact match: the versions are never taken for it.
    expect(unambiguousCandidate(versions, 'A')?.key).toBe('dz:1');
    expect(unambiguousCandidate(versions.slice(1), 'A')).toBeNull();
  });

  it('Re-release with the same tracks: release identifiers and dates stay with their own release', () => {
    const m = md({
      upc: '0724384960650',
      claims: [
        { source: 'musicbrainz', upc: '0724384960650', url: 'https://musicbrainz.org/release/orig', values: { upc: '0724384960650', releaseDate: '2001-03-12', labelName: 'Virgin' } },
        { source: 'musicbrainz', upc: '0190295000001', url: 'https://musicbrainz.org/release/reissue', values: { upc: '0190295000001', releaseDate: '2021-02-26', labelName: 'Parlophone' } },
      ],
    });
    const rows = evidenceRows(m);
    expect(rows.filter((r) => r.field === 'releaseDate').map((r) => [r.ref, r.value])).toEqual([
      ['upc:0724384960650', '2001-03-12'],
      ['upc:0190295000001', '2021-02-26'],
    ]);
    // Which releases the recording is on stays under the recording, one value per release.
    expect(rows.filter((r) => r.field === 'upc').map((r) => [r.ref, r.value])).toEqual([
      ['isrc:GBDUW0000059', '0724384960650'],
      ['isrc:GBDUW0000059', '0190295000001'],
    ]);
    // Merging two sources that disagree on the UPC reports it instead of picking silently.
    const merged = mergeResults({}, [{ source: 'deezer', upc: '724384960650' }, { source: 'musicbrainz', upc: '190295000001' }], { aliases: [], hints: [] }, []);
    expect(merged.conflicts.find((c) => c.field === 'upc')?.values.map((v) => v.source)).toEqual(['deezer', 'musicbrainz']);
  });

  it('Conflicting labels or P/C lines: shows the conflict and its sources instead of overwriting', () => {
    const merged = mergeResults({}, [{ source: 'deezer', labelName: 'Parlophone (France)', pLine: '℗ 2001 Daft Life' }, { source: 'musicbrainz', labelName: 'Virgin', pLine: '℗ 2001 Virgin Records' }], { aliases: [], hints: [] }, []);
    expect(merged.conflicts.map((c) => c.field).sort()).toEqual(['labelName', 'pLine']);
    const c = card({ md: { ...md(), ...merged, isrc: 'GBDUW0000059' } });
    const label = renderCard(c).embeds!.at(-1)!.fields!.find((f) => f.name === '🏷️ Label')!;
    expect(label.value).toBe('Parlophone (France) ⚠');
    const details = JSON.stringify(detailsView(c));
    expect(details).toContain('Where sources disagree');
    expect(details).toContain('MusicBrainz \\"Virgin\\"');
  });

  it('No licensor evidence: Unknown, never inferred from the label name alone', () => {
    const c = card({ md: md({ labelName: 'Parlophone (France)', distributor: { name: null, confidence: 0, evidence: [] } }) });
    expect(distributorEvidence(c)).toEqual({ value: null, evidence: { status: 'unknown', label: 'No source states the distributor' } });
    expect(renderCard(c).embeds![0].title).toBe('Distributor unknown');
  });

  it('One provider times out: partial data from the others, with a useful status', async () => {
    stub((u) => {
      if (u.startsWith('https://api.discogs.com')) throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
      if (u.startsWith('https://api.deezer.com/track/isrc:GBDUW0000059')) return json(DZ_TRACK);
      if (u.startsWith('https://api.deezer.com/album/302127')) return json(DZ_ALBUM);
      return null;
    });
    // The real path: Discogs is retried with backoff, then given up on.
    const r = await resolveMetadata({ kind: 'isrc', isrc: 'GBDUW0000059' }, { input: 'GBDUW0000059' }, { ...CTX, creds: { discogs: { token: 't' } }, scope: scope() });
    expect(r.title).toBe('Harder, Better, Faster, Stronger');
    expect(r.labelName).toBe('Parlophone (France)');
    expect(r.sources.find((s) => s.source === 'discogs')).toMatchObject({ ok: false, outcome: 'timeout' });
    expect(JSON.stringify(detailsView(card({ md: r })))).toContain('Discogs ✗ timed out');
  }, 30_000);

  it('Rate limit: backs off, and a source that keeps refusing is paused instead of hammered', async () => {
    expect(classify(new ProviderError('discogs', 'HTTP 429', { status: 429 }))).toBe('rate_limited');
    expect(classify(new RateLimitedError(1000))).toBe('rate_limited');
    const label = scope();
    for (let i = 0; i < BREAKER.failures; i++) await recordFailure('discogs', label, new ProviderError('discogs', 'HTTP 429', { status: 429 }));
    expect(await pausedFor('discogs', label)).toBeGreaterThan(0);
    stub((u) => (u.startsWith('https://api.deezer.com/track/isrc:GBDUW0000059') ? json(DZ_TRACK) : u.startsWith('https://api.deezer.com/album/302127') ? json(DZ_ALBUM) : null));
    const r = await resolveMetadata({ kind: 'isrc', isrc: 'GBDUW0000059' }, { input: 'GBDUW0000059' }, { ...CTX, creds: { discogs: { token: 't' } }, scope: label });
    expect(calls.some((c) => c.startsWith('https://api.discogs.com'))).toBe(false);
    expect(r.sources.find((s) => s.source === 'discogs')).toMatchObject({ outcome: 'paused' });
    expect(r.title).toBe('Harder, Better, Faster, Stronger');
  });

  it('Private label record in a public context: a shared card shows no label-only details', () => {
    const owned = card({ owned: { trackId: 't', url: 'https://console.example/catalog/tracks/t', release: null }, shared: { distributor: false, streams: false }, md: md({ plays: { platform: 'spotify', source: 'spotscraper', count: 5, at: '2026-10-11T10:00:00Z' } }) });
    const m = renderCard(owned);
    expect(m.embeds).toHaveLength(1); // no distributor card
    const main = m.embeds![0];
    expect(main.description).not.toContain('In your catalogue');
    expect(main.fields?.some((f) => f.name === '📈 Streams')).toBe(false);
    expect((m.components ?? []).flatMap((r) => r.components).some((b) => 'url' in b && b.url?.includes('console.example'))).toBe(false);
  });

  it('Invalid or hostile URL: rejected, or parsed without any server-side fetch', async () => {
    stub(() => json({}));
    for (const hostile of ['http://169.254.169.254/latest/meta-data', 'https://evil.example/track/1', 'file:///etc/passwd', 'https://open.spotify.com.evil.example/track/4uLU6hMCjMI75M1A2tKUQC', 'javascript:alert(1)']) {
      const p = parseInput(hostile);
      expect(p === null || p.kind === 'text', hostile).toBe(true);
    }
    // A supported link is reduced to its id: nothing from the URL is fetched as given.
    expect(parseInput('https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC?redirect=http://169.254.169.254/')).toMatchObject({ kind: 'spotify', id: '4uLU6hMCjMI75M1A2tKUQC' });
    const message = { id: '1', application_id: '1', type: 2, token: 't', data: { name: 'Look Up Song', type: 3, target_id: '9', resolved: { messages: { '9': { id: '9', content: 'listen https://evil.example/x and GBDUW0000059' } } } } };
    expect(songInMessage(message as never)).toBe('GBDUW0000059');
    expect(calls).toEqual([]);
  });
});

describe('circuit breaker', () => {
  it('pauses after repeated outages, clears on success, and pauses again straight after a pause', async () => {
    const source = `test-source-${scope()}`;
    const outage = new ProviderError(source, 'HTTP 503', { status: 503 });
    for (let i = 0; i < BREAKER.failures - 1; i++) expect(await recordFailure(source, null, outage)).toBe(false);
    await recordSuccess(source);
    expect(await recordFailure(source, null, outage)).toBe(false); // the success reset the count
    for (let i = 0; i < BREAKER.failures - 2; i++) await recordFailure(source, null, outage);
    expect(await recordFailure(source, null, outage)).toBe(true);
    expect(await pausedFor(source)).toBeGreaterThan(0);
    await redis().del(`lc:cb:open:${source}`); // the pause ends
    expect(await recordFailure(source, null, outage)).toBe(true); // half-open: one more failure pauses it again
    await resumeSource(source);
  });

  it("doesn't count errors retrying can't fix, and keys a label's own credentials per label", async () => {
    const [a, b] = [scope(), scope()];
    for (let i = 0; i < BREAKER.failures * 2; i++) await recordFailure('discogs', a, new ProviderError('discogs', 'HTTP 401', { status: 401 }));
    expect(await pausedFor('discogs', a)).toBeNull();
    for (let i = 0; i < BREAKER.failures; i++) await recordFailure('discogs', a, new ProviderError('discogs', 'HTTP 502', { status: 502 }));
    expect(await pausedFor('discogs', a)).toBeGreaterThan(0);
    expect(await pausedFor('discogs', b)).toBeNull();
    await resumeSource('discogs', a);
    expect(await pausedFor('discogs', a)).toBeNull();
  });
});

describe('evidence and provider terms', () => {
  it('keeps only sources whose terms allow it: MusicBrainz (CC0) and iTunes, not Spotify, Deezer or Discogs', () => {
    expect([retentionDays('musicbrainz'), retentionDays('itunes')]).toEqual([730, 30]);
    for (const s of ['spotify', 'spotscraper', 'deezer', 'discogs', 'apple', 'licensed']) expect(retentionDays(s), s).toBe(0);
    const rows = evidenceRows(
      md({
        claims: [
          { source: 'deezer', upc: '0724384960650', url: null, values: { labelName: 'Parlophone (France)' } },
          { source: 'spotscraper', upc: '0724384960650', url: null, values: { labelName: 'Parlophone' } },
          { source: 'musicbrainz', upc: '0724384960650', url: 'https://musicbrainz.org/release/rel-1', values: { labelName: 'Virgin', title: 'HBFS', isrc: 'GBDUW0000059' } },
        ],
      }),
    );
    expect(rows).toEqual([
      { ref: 'upc:0724384960650', field: 'labelName', source: 'musicbrainz', value: 'Virgin', sourceUrl: 'https://musicbrainz.org/release/rel-1' },
      { ref: 'isrc:GBDUW0000059', field: 'title', source: 'musicbrainz', value: 'HBFS', sourceUrl: 'https://musicbrainz.org/release/rel-1' },
    ]);
  });

  it('reports a source changing its value, with when it was seen, and nothing in between', () => {
    const at = (d: string) => new Date(`2026-${d}T12:00:00Z`);
    const changes = historyChanges([
      { ref: 'upc:1', field: 'labelName', source: 'musicbrainz', value: 'Virgin', firstSeenAt: at('09-01'), lastSeenAt: at('09-20') },
      { ref: 'upc:1', field: 'labelName', source: 'musicbrainz', value: 'Parlophone', firstSeenAt: at('10-02'), lastSeenAt: at('10-10') },
      { ref: 'upc:1', field: 'pLine', source: 'musicbrainz', value: '℗ 2001', firstSeenAt: at('09-01'), lastSeenAt: at('10-10') },
    ]);
    expect(changes).toEqual([{ field: 'labelName', source: 'musicbrainz', from: 'Virgin', to: 'Parlophone', lastSeenOld: at('09-20'), firstSeenNew: at('10-02') }]);
  });

  it('credits Discogs next to its data, linked to the Discogs page', () => {
    const m = md({ catalogNumber: 'V2940', platformIds: [{ platform: 'discogs', entity: 'release', externalId: '249504', url: 'https://www.discogs.com/release/249504', source: 'discogs' }] });
    expect(discogsCredit(m)).toBe('[Data provided by Discogs.](https://www.discogs.com/release/249504)');
    const release = renderCard(card({ kind: 'release', ref: 'upc:0724384960650', md: m }));
    expect(release.embeds!.at(-1)!.fields!.find((f) => f.name === '🗂️ Cat. No.')!.value).toBe('V2940\n[Data provided by Discogs.](https://www.discogs.com/release/249504)');
    expect(discogsCredit(md())).toBeNull();
  });

  it('links the Deezer preview instead of attaching the audio', () => {
    const c = card({ md: md({ platformIds: [{ platform: 'deezer', entity: 'track', externalId: '3135556', url: 'https://www.deezer.com/track/3135556', source: 'deezer' }] }) });
    const m = audioView(c, 'https://cdnt-preview.dzcdn.net/api/1/1/x.mp3?hdnea=exp=1');
    expect((m.components ?? []).flatMap((r) => r.components).map((b) => ('url' in b ? b.url : null))).toEqual(['https://cdnt-preview.dzcdn.net/api/1/1/x.mp3?hdnea=exp=1', 'https://www.deezer.com/track/3135556']);
    expect(audioView(card(), null).content).toBe('No preview is available for this song.');
  });
});

describe('metrics and benchmark', () => {
  it('sums each source’s outcomes, timing only the calls that reached it', () => {
    expect(
      sourceHealth([
        { source: 'deezer', outcome: 'answered', n: 8, p50: 120, p95: 400 },
        { source: 'deezer', outcome: 'timeout', n: 2, p50: 15000, p95: 15000 },
        { source: 'spotify', outcome: 'skipped', n: 10, p50: null, p95: null },
      ]),
    ).toEqual([
      { source: 'deezer', calls: 10, outcomes: { answered: 8, timeout: 2 }, p50: 120, p95: 400 },
      { source: 'spotify', calls: 0, outcomes: { skipped: 10 }, p50: null, p95: null },
    ]);
  });

  it('scores each source against the catalogue, field by field', () => {
    const item = { isrc: 'GBDUW0000059', title: 'Harder, Better, Faster, Stronger', artists: ['Daft Punk'], durationMs: 224000, releases: [{ upc: '724384960650', title: 'Discovery', releaseDate: '2001-03-07', labelName: 'Parlophone (France)', pLine: '℗ 2001 Daft Life Ltd.', cLine: null, distributor: 'Warner', distributorConfidence: null }] };
    const result = scoreBenchmark(
      [
        {
          item,
          md: md({
            pLine: '(P) 2001 Daft Life Ltd',
            distributor: { name: 'Warner Music', confidence: 0.6, evidence: [] },
            sources: [
              { source: 'deezer', ok: true, outcome: 'answered', ms: 200 },
              { source: 'musicbrainz', ok: true, outcome: 'answered', ms: 1100 },
            ],
            claims: [
              { source: 'deezer', upc: '0724384960650', url: null, values: { title: 'Harder, Better, Faster, Stronger', labelName: 'Parlophone (France)', durationMs: '224500', upc: '0724384960650', pLine: '(P) 2001 Daft Life Ltd' } },
              { source: 'musicbrainz', upc: '0724384960650', url: null, values: { labelName: 'Virgin', releaseDate: '2001-03-12' } },
            ],
          }),
        },
        { item, md: null },
      ],
      3,
    );
    const deezer = result.sources.find((s) => s.source === 'deezer')!;
    expect(deezer.fields.title).toEqual({ reported: 1, checked: 1, agreed: 1 });
    expect(deezer.fields.durationMs).toEqual({ reported: 1, checked: 1, agreed: 1 }); // within two seconds
    expect(deezer.fields.pLine).toEqual({ reported: 1, checked: 1, agreed: 1 }); // ℗ and (P) compare equal
    expect(deezer.p50).toBe(200);
    expect(result.sources.find((s) => s.source === 'musicbrainz')!.fields.labelName).toEqual({ reported: 1, checked: 1, agreed: 0 });
    expect(result.misses.map((m) => m.field).sort()).toEqual(['labelName', 'releaseDate']);
    expect(result.distributor).toEqual({ checked: 1, agreed: 1, unknown: 0 });
    expect(result).toMatchObject({ items: 2, billed: { spotscraper: 3 } });
  });

  it('compares credits by name and role', () => {
    const a = { source: 'musicbrainz', credits: [{ name: 'Thomas Bangalter', role: 'Producer' }, { name: 'Edwin Birdsong', role: 'Composer' }] };
    const b = { source: 'discogs', credits: [{ name: 'Thomas Bangalter', role: 'producer' }] };
    expect(compareCredits(a, { ...a })).toEqual({ same: true, count: 2 });
    expect(compareCredits(a, b)).toEqual({ same: false, value: '**Only 1 *(MusicBrainz)*:** Edwin Birdsong (Composer)\n**Only 2 *(Discogs)*:** nothing else' });
    expect(compareCredits(null, null)).toBeNull();
  });
});
