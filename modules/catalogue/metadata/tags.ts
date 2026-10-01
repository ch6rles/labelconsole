/**
 * Embedded tag reader for uploaded audio (ID3v2.3/2.4 in MP3, Vorbis comments
 * in FLAC). Only the fields metadata lookup needs: ISRC, title, artist,
 * album, label/publisher, year.
 */
export type AudioTags = { isrc?: string; title?: string; artist?: string; album?: string; label?: string; year?: string; durationMs?: number };

function syncsafe(b: Buffer, o: number) {
  return ((b[o] & 0x7f) << 21) | ((b[o + 1] & 0x7f) << 14) | ((b[o + 2] & 0x7f) << 7) | (b[o + 3] & 0x7f);
}

function decodeText(buf: Buffer): string {
  const enc = buf[0];
  const body = buf.subarray(1);
  let s: string;
  if (enc === 1 || enc === 2) {
    // UTF-16 with BOM (1) or UTF-16BE (2)
    let b = body;
    let le = enc === 1;
    if (b[0] === 0xff && b[1] === 0xfe) {
      le = true;
      b = b.subarray(2);
    } else if (b[0] === 0xfe && b[1] === 0xff) {
      le = false;
      b = b.subarray(2);
    }
    if (!le) {
      const swapped = Buffer.alloc(b.length - (b.length % 2));
      for (let i = 0; i + 1 < b.length; i += 2) {
        swapped[i] = b[i + 1];
        swapped[i + 1] = b[i];
      }
      b = swapped;
    }
    s = b.toString('utf16le');
  } else if (enc === 3) s = body.toString('utf8');
  else s = body.toString('latin1');
  return s.replace(/\0+$/g, '').split('\0')[0].trim();
}

const ID3_FIELDS: Record<string, keyof AudioTags> = { TSRC: 'isrc', TIT2: 'title', TPE1: 'artist', TALB: 'album', TPUB: 'label', TYER: 'year', TDRC: 'year' };

export function readId3(buf: Buffer): AudioTags {
  if (buf.subarray(0, 3).toString('latin1') !== 'ID3') return {};
  const version = buf[3];
  const size = syncsafe(buf, 6);
  const end = Math.min(buf.length, 10 + size);
  const tags: AudioTags = {};
  let o = 10;
  if (buf[5] & 0x40) o += version === 4 ? syncsafe(buf, 10) : buf.readUInt32BE(10) + 4; // extended header
  while (o + 10 <= end) {
    const id = buf.subarray(o, o + 4).toString('latin1');
    if (!/^[A-Z0-9]{4}$/.test(id)) break;
    const fsize = version === 4 ? syncsafe(buf, o + 4) : buf.readUInt32BE(o + 4);
    if (fsize <= 0 || o + 10 + fsize > end) break;
    const key = ID3_FIELDS[id];
    if (key && !tags[key]) {
      const value = decodeText(buf.subarray(o + 10, o + 10 + fsize));
      if (value) (tags as Record<string, string>)[key] = key === 'year' ? value.slice(0, 4) : value;
    }
    o += 10 + fsize;
  }
  return tags;
}

const VORBIS_FIELDS: Record<string, keyof AudioTags> = { ISRC: 'isrc', TITLE: 'title', ARTIST: 'artist', ALBUM: 'album', LABEL: 'label', ORGANIZATION: 'label', PUBLISHER: 'label', DATE: 'year' };

export function readFlac(buf: Buffer): AudioTags {
  if (buf.subarray(0, 4).toString('latin1') !== 'fLaC') return {};
  const tags: AudioTags = {};
  let o = 4;
  for (;;) {
    if (o + 4 > buf.length) break;
    const header = buf[o];
    const last = header & 0x80;
    const type = header & 0x7f;
    const len = buf.readUIntBE(o + 1, 3);
    const block = buf.subarray(o + 4, o + 4 + len);
    if (type === 0 && block.length >= 18) {
      // STREAMINFO: sample rate (20 bits) and total samples (36 bits) give the duration.
      const sampleRate = (block[10] << 12) | (block[11] << 4) | (block[12] >> 4);
      const totalSamples = (block[13] & 0x0f) * 2 ** 32 + block.readUInt32BE(14);
      if (sampleRate > 0) tags.durationMs = Math.round((totalSamples / sampleRate) * 1000);
    }
    if (type === 4) {
      let p = 0;
      const vendorLen = block.readUInt32LE(p);
      p += 4 + vendorLen;
      const count = block.readUInt32LE(p);
      p += 4;
      for (let i = 0; i < count && p + 4 <= block.length; i++) {
        const l = block.readUInt32LE(p);
        const kv = block.subarray(p + 4, p + 4 + l).toString('utf8');
        p += 4 + l;
        const eq = kv.indexOf('=');
        const key = VORBIS_FIELDS[kv.slice(0, eq).toUpperCase()];
        if (key && !tags[key]) (tags as Record<string, string>)[key] = key === 'year' ? kv.slice(eq + 1, eq + 5) : kv.slice(eq + 1).trim();
      }
    }
    o += 4 + len;
    if (last) break;
  }
  return tags;
}

export function readTags(buf: Buffer): AudioTags {
  return buf.subarray(0, 3).toString('latin1') === 'ID3' ? readId3(buf) : readFlac(buf);
}
