import { fetchJson } from '@labelconsole/core/http';

/** Resolve a YouTube link to a title we can search other catalogues with. */
export async function youtubeTitle(videoId: string, apiKey?: string | null): Promise<{ title: string; channel: string } | null> {
  if (apiKey) {
    const res = await fetchJson<{ items: Array<{ snippet: { title: string; channelTitle: string } }> }>(
      `https://www.googleapis.com/youtube/v3/videos?part=snippet&id=${videoId}&key=${encodeURIComponent(apiKey)}`,
      { provider: 'youtube', rateLimit: { key: 'youtube', capacity: 10, refillPerSec: 5 } },
    );
    const s = res?.items[0]?.snippet;
    if (s) return { title: s.title, channel: s.channelTitle.replace(/ - Topic$/, '') };
  }
  const o = await fetchJson<{ title?: string; author_name?: string }>(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(`https://www.youtube.com/watch?v=${videoId}`)}`, { provider: 'youtube', allow404: true, retries: 1 });
  return o?.title ? { title: o.title, channel: (o.author_name ?? '').replace(/ - Topic$/, '') } : null;
}

/** "Artist - Title (Official Video)" → { artist, title } */
export function splitVideoTitle(raw: string, channel: string): { title: string; artist: string | null } {
  const cleaned = raw.replace(/\s*[([](official|lyric|audio|music|visuali[sz]er|video|hd|4k)[^)\]]*[)\]]/gi, '').trim();
  const m = cleaned.match(/^(.+?)\s+[-–—]\s+(.+)$/);
  if (m) return { artist: m[1].trim(), title: m[2].trim() };
  return { title: cleaned, artist: channel || null };
}
