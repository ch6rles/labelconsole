/**
 * Pure helpers behind the viewers, kept apart from the components so they can
 * be tested: what a file is from its first bytes, a font's own description of
 * itself, and spreadsheet column names and numbers.
 */
import type { Cell } from '@labelconsole/core/xlsx';

/** What a file most likely is, from its first bytes. */
const MAGIC: Array<[number[] | string, string, number?]> = [
  [[0x50, 0x4b, 0x03, 0x04], 'Zip archive (or a format built on zip)'],
  [[0x52, 0x61, 0x72, 0x21], 'RAR archive'],
  [[0x37, 0x7a, 0xbc, 0xaf], '7-Zip archive'],
  [[0x1f, 0x8b], 'Gzip-compressed file'],
  ['ustar', 'Tar archive', 257],
  ['%PDF', 'PDF document'],
  [[0xd0, 0xcf, 0x11, 0xe0], 'Old Microsoft Office document (.doc, .xls or .ppt)'],
  ['{\\rtf', 'Rich Text document'],
  [[0x89, 0x50, 0x4e, 0x47], 'PNG image'],
  [[0xff, 0xd8, 0xff], 'JPEG image'],
  ['GIF8', 'GIF image'],
  ['8BPS', 'Photoshop document'],
  [[0x49, 0x49, 0x2a, 0x00], 'TIFF image'],
  [[0x4d, 0x4d, 0x00, 0x2a], 'TIFF image'],
  ['ID3', 'MP3 audio'],
  [[0xff, 0xfb], 'MP3 audio'],
  ['fLaC', 'FLAC audio'],
  ['OggS', 'Ogg audio or video'],
  ['FORM', 'AIFF audio'],
  ['MThd', 'MIDI file'],
  ['ftyp', 'MP4 / QuickTime media', 4],
  [[0x1a, 0x45, 0xdf, 0xa3], 'Matroska / WebM video'],
  ['SQLite format 3', 'SQLite database'],
  [[0x4d, 0x5a], 'Windows program (.exe or .dll)'],
  [[0x7f, 0x45, 0x4c, 0x46], 'Linux program (ELF)'],
  [[0xcf, 0xfa, 0xed, 0xfe], 'macOS program'],
  ['bplist', 'Apple property list'],
  ['wOFF', 'WOFF font'],
  ['wOF2', 'WOFF2 font'],
];

export function sniff(bytes: Uint8Array): string | null {
  for (const [sig, label, at = 0] of MAGIC) {
    const want = typeof sig === 'string' ? [...sig].map((c) => c.charCodeAt(0)) : sig;
    if (want.every((b, i) => bytes[at + i] === b)) {
      if (label.startsWith('Zip') || label.startsWith('MP4')) return label;
      if (label === 'AIFF audio' && String.fromCharCode(...bytes.slice(8, 12)) !== 'AIFF' && String.fromCharCode(...bytes.slice(8, 12)) !== 'AIFC') continue;
      return label;
    }
  }
  if (String.fromCharCode(...bytes.slice(0, 4)) === 'RIFF') {
    const kind = String.fromCharCode(...bytes.slice(8, 12));
    return kind === 'WAVE' ? 'WAV audio' : kind === 'AVI ' ? 'AVI video' : kind === 'WEBP' ? 'WebP image' : 'RIFF container';
  }
  return null;
}

export type FontInfo = Partial<Record<'family' | 'style' | 'full' | 'version' | 'designer' | 'maker' | 'copyright' | 'license' | 'licenseUrl' | 'description', string>> & { glyphs?: number };
const NAME_IDS: Record<number, keyof FontInfo> = { 0: 'copyright', 1: 'family', 2: 'style', 4: 'full', 5: 'version', 8: 'maker', 9: 'designer', 10: 'description', 13: 'license', 14: 'licenseUrl', 16: 'family', 17: 'style' };

/** The tables of a TrueType/OpenType font, or of a WOFF wrapper (inflated). WOFF2 needs Brotli and is skipped. */
export async function fontTables(buf: ArrayBuffer): Promise<Map<string, DataView> | null> {
  const v = new DataView(buf);
  const tag = (o: number) => String.fromCharCode(v.getUint8(o), v.getUint8(o + 1), v.getUint8(o + 2), v.getUint8(o + 3));
  const sig = tag(0);
  const out = new Map<string, DataView>();
  if (sig === 'wOFF') {
    const n = v.getUint16(12);
    for (let i = 0; i < n; i++) {
      const o = 44 + i * 20;
      const t = tag(o);
      if (t !== 'name' && t !== 'maxp') continue;
      const offset = v.getUint32(o + 4);
      const comp = v.getUint32(o + 8);
      const orig = v.getUint32(o + 12);
      const slice = buf.slice(offset, offset + comp);
      if (comp >= orig) out.set(t, new DataView(slice));
      else {
        const inflated = await new Response(new Blob([slice]).stream().pipeThrough(new DecompressionStream('deflate'))).arrayBuffer();
        out.set(t, new DataView(inflated));
      }
    }
    return out;
  }
  if (sig === 'wOF2') return null;
  if (sig !== 'OTTO' && v.getUint32(0) !== 0x00010000 && sig !== 'true') return null;
  const n = v.getUint16(4);
  for (let i = 0; i < n; i++) {
    const o = 12 + i * 16;
    out.set(tag(o), new DataView(buf, v.getUint32(o + 8), v.getUint32(o + 12)));
  }
  return out;
}

export function fontInfo(tables: Map<string, DataView>): FontInfo {
  const info: FontInfo = {};
  const name = tables.get('name');
  if (name) {
    const count = name.getUint16(2);
    const strings = name.getUint16(4);
    const found: Record<string, { text: string; score: number }> = {};
    for (let i = 0; i < count; i++) {
      const o = 6 + i * 12;
      const platform = name.getUint16(o);
      const language = name.getUint16(o + 4);
      const id = name.getUint16(o + 6);
      const len = name.getUint16(o + 8);
      const off = strings + name.getUint16(o + 10);
      const key = NAME_IDS[id];
      if (!key || off + len > name.byteLength) continue;
      const bytes = new Uint8Array(name.buffer, name.byteOffset + off, len);
      const text = platform === 1 ? new TextDecoder('latin1').decode(bytes) : new TextDecoder('utf-16be').decode(bytes);
      // Prefer Windows English names, and the "typographic" family/style (16/17) over the legacy ones.
      const score = (platform === 3 && language === 0x409 ? 2 : platform === 0 ? 1 : 0) + (id >= 16 ? 4 : 0);
      if (!found[key] || score > found[key].score) found[key] = { text: text.replace(/\0/g, '').trim(), score };
    }
    for (const [k, v] of Object.entries(found)) info[k as keyof Omit<FontInfo, 'glyphs'>] = v.text;
  }
  const maxp = tables.get('maxp');
  if (maxp && maxp.byteLength >= 6) info.glyphs = maxp.getUint16(4);
  return info;
}

/** A, B, … Z, AA, AB … like a spreadsheet's column headings. */
export function columnName(i: number) {
  let s = '';
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

/** A cell's number: Excel numbers as they are, CSV text that reads as a number ("1,234.50", "$12", "-3e2") parsed. */
export function numeric(v: Cell): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v !== 'string') return null;
  const t = v.trim();
  if (!/^[-+]?[$€£¥]?\s?(\d{1,3}(,\d{3})+|\d+)?(\.\d+)?(e[-+]?\d+)?%?$/i.test(t) || !/\d/.test(t)) return null;
  const n = Number(t.replace(/[$€£¥,%\s]/g, ''));
  return Number.isFinite(n) ? n : null;
}
