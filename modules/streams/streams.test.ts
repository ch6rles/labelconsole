import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { isPublicHttps } from '@labelconsole/core/net';
import { evaluateRules, type RuleLike } from './service/alerts';
import { statementPeriodTotals } from './sources/statements';
import { platformSlug } from './sources/types';
import { parseIsoDuration, parseVideoId, scoreCandidates, type SearchCandidate } from './sources/youtube';
import { candidateFrom } from './sources/youtube-apify';

const cand = (over: Partial<SearchCandidate>): SearchCandidate => ({ videoId: 'aaaaaaaaaaa', title: 'Tidewater', channelTitle: 'Mara Ellis - Topic', channelId: 'UC1', durationSec: 214, viewCount: 1000, publishedAt: null, description: 'Provided to YouTube by DistroKid', ...over });

describe('youtube helpers', () => {
  it('parses ISO 8601 durations', () => {
    expect(parseIsoDuration('PT3M34S')).toBe(214);
    expect(parseIsoDuration('PT1H2M')).toBe(3720);
    expect(parseIsoDuration('P1DT1S')).toBe(86401);
    expect(parseIsoDuration(undefined)).toBeNull();
  });

  it('extracts video IDs from links', () => {
    expect(parseVideoId('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=10')).toBe('dQw4w9WgXcQ');
    expect(parseVideoId('https://music.youtube.com/watch?v=dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ');
    expect(parseVideoId('https://youtu.be/dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ');
    expect(parseVideoId('https://www.youtube.com/shorts/dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ');
    expect(parseVideoId('dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ');
    expect(parseVideoId('https://vimeo.com/123')).toBeNull();
  });
});

describe('youtube matching', () => {
  const track = { title: 'Tidewater', artists: ['Mara Ellis'], durationMs: 214_000 };

  it('confirms the Topic art track with matching length', () => {
    const [best] = scoreCandidates(track, [cand({})]);
    expect(best).toMatchObject({ variant: 'topic' });
    expect(best.confidence).toBeGreaterThanOrEqual(0.85);
  });

  it('ranks topic first, then the official video, and rejects other versions and strangers', () => {
    const verdicts = scoreCandidates(track, [
      cand({ videoId: 'official000', title: 'Mara Ellis - Tidewater (Official Video)', channelTitle: 'Mara Ellis', durationSec: 240, description: '' }),
      cand({ videoId: 'remix000000', title: 'Tidewater (Kofi Remix)', channelTitle: 'Mara Ellis - Topic' }),
      cand({ videoId: 'stranger000', title: 'Tidewater', channelTitle: 'Some Other Band - Topic' }),
      cand({ videoId: 'topic000000' }),
    ]);
    expect(verdicts.map((v) => v.videoId)).toEqual(['topic000000', 'remix000000', 'official000']);
    expect(verdicts.find((v) => v.videoId === 'remix000000')!.confidence).toBeLessThan(0.5);
    const official = verdicts.find((v) => v.videoId === 'official000')!;
    expect(official.confidence).toBeGreaterThanOrEqual(0.5);
    expect(official.confidence).toBeLessThan(0.85); // goes to review
  });

  it('penalises a topic upload whose length is far off', () => {
    const [v] = scoreCandidates(track, [cand({ durationSec: 400 })]);
    expect(v.confidence).toBeLessThan(0.85);
  });
});

describe('youtube through Apify', () => {
  /** A live search result from apidojo/youtube-scraper, descriptions trimmed. */
  const search = JSON.parse(readFileSync(join(__dirname, 'sources/__fixtures__/youtube-apify-search.json'), 'utf8')) as unknown[];

  it('reads scraped videos as search candidates', () => {
    const c = search.map(candidateFrom).filter((x): x is SearchCandidate => Boolean(x));
    expect(c).toHaveLength(5);
    expect(c.find((x) => x.videoId === '3BFTio5296w')).toMatchObject({ title: 'Never Gonna Give You Up (2022 Remaster)', channelTitle: 'Rick Astley - Topic', durationSec: 214, viewCount: 12947987, description: expect.stringMatching(/^Provided to YouTube by BMG/) });
    expect(candidateFrom({ id: 'bad id', views: 3 })).toBeNull();
    expect(candidateFrom({ type: 'channel', id: 'UCuAXFkgsw1' })).toBeNull();
  });

  it('matches the art track (what YouTube Music plays) with confidence, and the official video for review', () => {
    const c = search.map(candidateFrom).filter((x): x is SearchCandidate => Boolean(x));
    const verdicts = scoreCandidates({ title: 'Never Gonna Give You Up', artists: ['Rick Astley'], durationMs: 213_573 }, c);
    expect(verdicts[0]).toMatchObject({ videoId: '3BFTio5296w', variant: 'topic' });
    expect(verdicts[0].confidence).toBeGreaterThanOrEqual(0.85);
    const official = verdicts.find((v) => v.variant === 'official');
    expect(official?.videoId).toBe('dQw4w9WgXcQ');
    // Re-uploads by other channels stay below the review threshold, so they are never picked.
    expect(verdicts.find((v) => v.videoId === 'miLcaqq2Zpk')!.confidence).toBeLessThan(0.5);
  });
});

describe('alert rules', () => {
  const day = (i: number) => new Date(Date.UTC(2026, 8, 1 + i)).toISOString().slice(0, 10);
  const series = (deltas: number[], startTotal = 50_000) => {
    let total = startTotal;
    return deltas.map((d, i) => ({ day: day(i), total: (total += d), delta: d }));
  };
  const rule = (r: Partial<RuleLike>): RuleLike => ({ id: 'r', kind: 'spike', threshold: 200, windowDays: 7, minDaily: 100, platform: null, ...r });

  it('flags a spike on the last complete day against the trailing average', () => {
    const pts = series([1000, 1100, 900, 1000, 1000, 1050, 950, 4200]);
    const [hit] = evaluateRules([rule({})], 'youtube', pts, day(7));
    expect(hit).toMatchObject({ kind: 'spike', value: 4200, baseline: 1000 });
    expect(hit.message).toMatch(/^YouTube plays up 320% on Sep 8/);
  });

  it('flags a drop, and stays quiet without enough history or below the noise floor', () => {
    const pts = series([2000, 2100, 1900, 2000, 2000, 300]);
    expect(evaluateRules([rule({ kind: 'drop', threshold: 60, minDaily: 1000 })], 'youtube', pts, day(5))[0]).toMatchObject({ kind: 'drop', value: 300 });
    expect(evaluateRules([rule({})], 'youtube', series([1000, 5000]), day(1))).toEqual([]);
    expect(evaluateRules([rule({ minDaily: 10_000 })], 'youtube', series([10, 10, 10, 10, 90]), day(4))).toEqual([]);
  });

  it('fires a milestone once, on the day the total crosses it', () => {
    const pts = series([500, 600], 99_000);
    expect(evaluateRules([rule({ kind: 'milestone', threshold: 100_000 })], 'spotify', pts, day(1))[0]).toMatchObject({ kind: 'milestone', message: 'Passed 100K on Spotify' });
    expect(evaluateRules([rule({ kind: 'milestone', threshold: 100_000 })], 'spotify', series([500, 600], 200_000), day(1))).toEqual([]);
  });

  it('respects a rule limited to one platform', () => {
    const pts = series([1000, 1000, 1000, 5000]);
    expect(evaluateRules([rule({ platform: 'spotify' })], 'youtube', pts, day(3))).toEqual([]);
  });
});

describe('statement totals', () => {
  it('sums units per track, platform and period, clamping returns at zero', () => {
    expect(
      statementPeriodTotals([
        { trackId: 't1', source: 'Spotify', periodEnd: '2026-07-31', units: 1000 },
        { trackId: 't1', source: 'Spotify', periodEnd: '2026-07-31', units: 250 },
        { trackId: 't1', source: 'iTunes', periodEnd: '2026-07-31', units: -3 },
        { trackId: null, source: 'Spotify', periodEnd: '2026-07-31', units: 99 },
        { trackId: 't1', source: 'YouTube (Red)', periodEnd: null, units: 5 },
      ]),
    ).toEqual([
      { trackId: 't1', platform: 'spotify', periodEnd: '2026-07-31', units: 1250 },
      { trackId: 't1', platform: 'apple_music', periodEnd: '2026-07-31', units: 0 },
    ]);
    expect(platformSlug('Amazon Unlimited')).toBe('amazon_music');
    expect(platformSlug('Anghami')).toBe('anghami');
  });
});

describe('webhook URL guard', () => {
  it('only allows public https endpoints', () => {
    expect(isPublicHttps('https://hooks.example.com/streams')).toBe(true);
    expect(isPublicHttps('http://hooks.example.com/streams')).toBe(false);
    expect(isPublicHttps('https://localhost/x')).toBe(false);
    expect(isPublicHttps('https://169.254.169.254/latest')).toBe(false);
    expect(isPublicHttps('https://10.0.0.5/x')).toBe(false);
    expect(isPublicHttps('https://[::1]/x')).toBe(false);
    expect(isPublicHttps('not a url')).toBe(false);
  });
});
