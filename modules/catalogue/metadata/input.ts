/** Recognise what a user pasted: ISRC, UPC/EAN, a DSP link, or "title - artist". */
export type ParsedInput =
  | { kind: 'isrc'; isrc: string }
  | { kind: 'upc'; upc: string }
  | { kind: 'spotify'; entity: 'track' | 'album'; id: string; url: string }
  | { kind: 'apple'; entity: 'track' | 'album'; id: string; storefront: string; url: string }
  | { kind: 'deezer'; entity: 'track' | 'album'; id: string; url: string }
  | { kind: 'youtube'; videoId: string; url: string }
  | { kind: 'text'; title: string; artist: string | null }
  | { kind: 'file'; fileId: string };

const ISRC_RE = /^[A-Z]{2}[A-Z0-9]{3}\d{7}$/;

export function normalizeIsrc(raw: string): string | null {
  const s = raw.toUpperCase().replace(/[^A-Z0-9]/g, '');
  return ISRC_RE.test(s) ? s : null;
}

/** GS1 check digit over the first n-1 digits. */
export function gs1CheckDigit(digits: string): number {
  const body = digits.slice(0, -1);
  let sum = 0;
  for (let i = 0; i < body.length; i++) {
    const d = Number(body[body.length - 1 - i]);
    sum += i % 2 === 0 ? d * 3 : d;
  }
  return (10 - (sum % 10)) % 10;
}

export function isValidGtin(digits: string) {
  return /^\d{12,14}$/.test(digits) && gs1CheckDigit(digits) === Number(digits[digits.length - 1]);
}

/** UPC-A (12) and EAN-13 refer to the same GTIN; compare and store as 13 digits. */
export function normalizeUpc(raw: string): string | null {
  const s = raw.replace(/\D/g, '');
  if (!isValidGtin(s)) return null;
  if (s.length === 12) return `0${s}`;
  if (s.length === 14 && s.startsWith('0')) return s.slice(1);
  return s;
}

/** Display form: drop the leading zero from 13-digit codes that are really UPC-A. */
export function displayUpc(upc: string | null | undefined) {
  if (!upc) return null;
  return upc.length === 13 && upc.startsWith('0') ? upc.slice(1) : upc;
}

export function parseInput(raw: string): ParsedInput | null {
  const s = raw.trim();
  if (!s) return null;
  const isrc = normalizeIsrc(s);
  if (isrc && !/\s/.test(s)) return { kind: 'isrc', isrc };
  if (/^[\d\s-]{12,17}$/.test(s)) {
    const upc = normalizeUpc(s);
    if (upc) return { kind: 'upc', upc };
  }
  let url: URL | null = null;
  try {
    url = new URL(s.startsWith('http') ? s : `https://${s}`);
  } catch {
    url = null;
  }
  if (url && /\./.test(url.hostname)) {
    const host = url.hostname.replace(/^www\./, '');
    const parts = url.pathname.split('/').filter(Boolean);
    if (host === 'open.spotify.com' || host === 'play.spotify.com') {
      const i = parts.findIndex((p) => p === 'track' || p === 'album');
      if (i >= 0 && parts[i + 1]) return { kind: 'spotify', entity: parts[i] as 'track' | 'album', id: parts[i + 1], url: url.toString() };
    }
    if (host === 'music.apple.com' || host === 'itunes.apple.com') {
      const storefront = parts[0]?.length === 2 ? parts[0] : 'us';
      const trackId = url.searchParams.get('i');
      if (trackId) return { kind: 'apple', entity: 'track', id: trackId, storefront, url: url.toString() };
      const songIdx = parts.indexOf('song');
      if (songIdx >= 0) return { kind: 'apple', entity: 'track', id: parts[parts.length - 1], storefront, url: url.toString() };
      const albumIdx = parts.indexOf('album');
      if (albumIdx >= 0) return { kind: 'apple', entity: 'album', id: parts[parts.length - 1].replace(/^id/, ''), storefront, url: url.toString() };
    }
    if (host.endsWith('deezer.com') || host === 'deezer.page.link') {
      const i = parts.findIndex((p) => p === 'track' || p === 'album');
      if (i >= 0 && parts[i + 1]) return { kind: 'deezer', entity: parts[i] as 'track' | 'album', id: parts[i + 1], url: url.toString() };
    }
    if (host === 'youtube.com' || host === 'music.youtube.com' || host === 'm.youtube.com' || host === 'youtu.be') {
      const id = host === 'youtu.be' ? parts[0] : url.searchParams.get('v') ?? (parts[0] === 'shorts' ? parts[1] : null);
      if (id && /^[A-Za-z0-9_-]{11}$/.test(id)) return { kind: 'youtube', videoId: id, url: url.toString() };
    }
    if (/^https?:/i.test(s)) return null; // a link we do not understand
  }
  const m = s.match(/^(.+?)\s+[-–—]\s+(.+)$/) ?? s.match(/^(.+?)\s+by\s+(.+)$/i);
  if (m) {
    // "Artist - Title" is the common convention; "Title by Artist" also works.
    return / by /i.test(s) ? { kind: 'text', title: m[1].trim(), artist: m[2].trim() } : { kind: 'text', title: m[2].trim(), artist: m[1].trim() };
  }
  return { kind: 'text', title: s, artist: null };
}
