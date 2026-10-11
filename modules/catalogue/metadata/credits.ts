import { fetchJson } from '@labelconsole/core/http';
import type { ResolvedMetadata } from '../schema';
import type { ResolveCredentials } from './resolve';
import { discogsCredits, discogsRelease } from './sources/discogs';

export type Credit = { name: string; role: string };

const MB_RL = { key: 'musicbrainz', capacity: 1, refillPerSec: 1 };

type MbRel = { type: string; 'target-type'?: string; attributes?: string[]; artist?: { name: string }; work?: { title: string; relations?: MbRel[] } };

const MB_ROLES: Record<string, string> = {
  producer: 'Producer',
  mix: 'Mixing Engineer',
  mastering: 'Mastering Engineer',
  recording: 'Recording Engineer',
  engineer: 'Engineer',
  programming: 'Programming',
  composer: 'Composer',
  lyricist: 'Lyricist',
  writer: 'Songwriter',
  arranger: 'Arranger',
  'vocal arranger': 'Vocal Arranger',
  'instrument arranger': 'Arranger',
  orchestrator: 'Orchestrator',
  conductor: 'Conductor',
  remixer: 'Remixer',
};

const title = (s: string) => s.replace(/\b\w/g, (c) => c.toUpperCase());

function mbRole(r: MbRel): string {
  if (r.type === 'vocal') return r.attributes?.length ? `${title(r.attributes.join(', '))}` : 'Vocals';
  if (r.type === 'instrument') return r.attributes?.length ? title(r.attributes.join(', ')) : 'Instruments';
  return MB_ROLES[r.type] ?? title(r.type);
}

/** Recording relationships (producers, engineers, performers) and the work's writers. */
async function musicbrainzCredits(recordingId: string): Promise<Credit[]> {
  if (!/^[0-9a-f-]{36}$/.test(recordingId)) return [];
  const res = await fetchJson<{ 'artist-credit'?: Array<{ name: string }>; relations?: MbRel[] }>(
    `https://musicbrainz.org/ws/2/recording/${recordingId}?inc=artist-credits+artist-rels+work-rels+work-level-rels&fmt=json`,
    { provider: 'musicbrainz', rateLimit: MB_RL, allow404: true, timeoutMs: 20_000 },
  );
  if (!res) return [];
  const out: Credit[] = (res['artist-credit'] ?? []).map((a) => ({ name: a.name, role: 'Main Artist' }));
  for (const r of res.relations ?? []) {
    if (r['target-type'] === 'artist' && r.artist) out.push({ name: r.artist.name, role: mbRole(r) });
    if (r['target-type'] === 'work') for (const w of r.work?.relations ?? []) if (w.artist) out.push({ name: w.artist.name, role: mbRole(w) });
  }
  return out;
}

const dedupe = (list: Credit[]) => {
  const seen = new Set<string>();
  return list.filter((c) => {
    const k = `${c.name.toLowerCase()}|${c.role.toLowerCase()}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
};

/**
 * Credits for a recording from public sources, best first: Spotify's credits
 * (through SpotScraper, one billed request), MusicBrainz relationships, then
 * Discogs. Returns the first source that has more than the main artists.
 */
export async function fetchCredits(creds: ResolveCredentials, md: ResolvedMetadata): Promise<{ source: string; credits: Credit[] } | null> {
  const id = (platform: string, entity: 'track' | 'release') => md.platformIds.find((p) => p.platform === platform && p.entity === entity)?.externalId;
  const enough = (list: Credit[]) => list.some((c) => c.role !== 'Main Artist');
  const spotifyId = id('spotify', 'track');
  if (creds.spotscraper && spotifyId) {
    const res = await creds.spotscraper.credits(spotifyId).catch(() => null);
    if (res?.credits.length) return { source: 'spotscraper', credits: dedupe(res.credits) };
  }
  const recording = id('musicbrainz', 'track');
  if (recording) {
    const list = dedupe(await musicbrainzCredits(recording).catch(() => []));
    if (enough(list)) return { source: 'musicbrainz', credits: list };
  }
  const discogsId = id('discogs', 'release');
  if (creds.discogs && discogsId) {
    const release = await discogsRelease(creds.discogs, discogsId).catch(() => null);
    const list = release ? dedupe(discogsCredits(release, md.title)) : [];
    if (enough(list)) return { source: 'discogs', credits: list };
  }
  return null;
}
