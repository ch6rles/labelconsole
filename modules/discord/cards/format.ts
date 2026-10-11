import type { Embed } from '../protocol/types';

export const COLOR = 0x3b5bdb;

const SOURCE_NAMES: Record<string, string> = {
  spotify: 'Spotify',
  spotscraper: 'Spotify (SpotScraper)',
  apple: 'Apple Music',
  itunes: 'iTunes',
  deezer: 'Deezer',
  musicbrainz: 'MusicBrainz',
  discogs: 'Discogs',
  licensed: 'licensed provider',
  tags: 'file tags',
  search: 'search',
  youtube: 'YouTube',
  catalogue: 'your catalogue',
};
const PLATFORM_NAMES: Record<string, string> = { spotify: 'Spotify', apple: 'Apple Music', deezer: 'Deezer', youtube: 'YouTube', youtube_music: 'YouTube Music', musicbrainz: 'MusicBrainz', discogs: 'Discogs', tidal: 'Tidal', amazon: 'Amazon Music', soundcloud: 'SoundCloud' };

export const sourceName = (s: string) => SOURCE_NAMES[s] ?? s;
export const platformName = (p: string) => PLATFORM_NAMES[p] ?? p.charAt(0).toUpperCase() + p.slice(1);

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

export const formatNumber = (n: number) => n.toLocaleString('en-US');
export const formatElapsed = (ms: number) => (ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`);
export const displayUpc = (upc: string | null | undefined) => (upc ? (upc.length === 13 && upc.startsWith('0') ? upc.slice(1) : upc) : null);
export const RELEASE_TYPES: Record<string, string> = { single: 'Single', ep: 'EP', album: 'Album', compilation: 'Compilation' };

/** A country code as its flag (regional indicator letters). */
export const flag = (code: string) => (/^[A-Z]{2}$/.test(code) ? String.fromCodePoint(...[...code].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65)) : code);

const regions = (() => {
  try {
    return new Intl.DisplayNames(['en'], { type: 'region' });
  } catch {
    return null;
  }
})();
export const countryName = (code: string) => {
  try {
    return regions?.of(code) ?? code;
  } catch {
    return code;
  }
};

/** Countries and territories with an ISO 3166-1 code that streaming services list (Antarctica and the like left out). */
export const COUNTRIES = (
  'AD AE AF AG AI AL AM AO AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ ' +
  'DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GT GU GW GY HK HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP ' +
  'KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ ' +
  'OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TG TH TJ TK TL TM TN TO TR TT TV TW TZ ' +
  'UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS XK YE YT ZA ZM ZW'
).split(' ');

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

/** Fit several embeds into one message's shared 6000-character budget, largest last to give way. */
export function fitEmbeds(embeds: Embed[]): Embed[] {
  const fitted = embeds.map((e) => fitEmbed(e));
  let total = fitted.reduce((n, e) => n + embedLength(e), 0);
  for (let i = fitted.length - 1; i >= 0 && total > EMBED_TOTAL_MAX; i--) {
    const before = embedLength(fitted[i]);
    fitted[i] = fitEmbed(fitted[i], Math.max(50, before - (total - EMBED_TOTAL_MAX)));
    total -= before - embedLength(fitted[i]);
  }
  return fitted;
}

/** A field value from a list of lines, cut to Discord's 1024 characters with a count of what was left out. */
export function listValue(lines: string[], max = 1024) {
  let out = '';
  for (const [i, line] of lines.entries()) {
    const rest = lines.length - i;
    const tail = `\n…and ${rest} more`;
    if (out.length + line.length + 1 > max - (rest > 1 ? tail.length : 0)) return out + (out ? tail : truncate(line, max));
    out += (out ? '\n' : '') + line;
  }
  return out || '—';
}
