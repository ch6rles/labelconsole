/**
 * What the audio viewer reads from a track in the browser: tags (ID3 in MP3s,
 * Vorbis comments in FLACs) with any artwork, a waveform, and levels: sample
 * peak, RMS and integrated loudness (LUFS, ITU-R BS.1770), the number the
 * streaming services normalise to.
 */
export type AudioTags = Partial<Record<'title' | 'artist' | 'album' | 'albumArtist' | 'year' | 'genre' | 'track' | 'isrc' | 'bpm' | 'key' | 'label' | 'composer' | 'copyright' | 'comment', string>> & { picture?: string };

const ID3_FRAMES: Record<string, keyof Omit<AudioTags, 'picture'>> = {
  TIT2: 'title', TPE1: 'artist', TALB: 'album', TPE2: 'albumArtist', TYER: 'year', TDRC: 'year', TCON: 'genre', TRCK: 'track', TSRC: 'isrc', TBPM: 'bpm', TKEY: 'key', TPUB: 'label', TCOM: 'composer', TCOP: 'copyright', COMM: 'comment',
  TT2: 'title', TP1: 'artist', TAL: 'album', TYE: 'year', TCO: 'genre', TRK: 'track', TBP: 'bpm',
};
const VORBIS: Record<string, keyof Omit<AudioTags, 'picture'>> = {
  TITLE: 'title', ARTIST: 'artist', ALBUM: 'album', ALBUMARTIST: 'albumArtist', DATE: 'year', YEAR: 'year', GENRE: 'genre', TRACKNUMBER: 'track', ISRC: 'isrc', BPM: 'bpm', INITIALKEY: 'key', KEY: 'key', LABEL: 'label', ORGANIZATION: 'label', COMPOSER: 'composer', COPYRIGHT: 'copyright', COMMENT: 'comment', DESCRIPTION: 'comment',
};

const syncsafe = (b: Uint8Array, o: number) => (b[o] << 21) | (b[o + 1] << 14) | (b[o + 2] << 7) | b[o + 3];
const be32 = (b: Uint8Array, o: number) => ((b[o] << 24) >>> 0) + (b[o + 1] << 16) + (b[o + 2] << 8) + b[o + 3];
const le32 = (b: Uint8Array, o: number) => b[o] + (b[o + 1] << 8) + (b[o + 2] << 16) + ((b[o + 3] << 24) >>> 0);

function decodeId3Text(b: Uint8Array, enc: number) {
  const label = enc === 1 ? 'utf-16' : enc === 2 ? 'utf-16be' : enc === 3 ? 'utf-8' : 'latin1';
  return new TextDecoder(label).decode(b).replace(/\0+$/g, '').split('\0').filter(Boolean).join(', ').trim();
}

/** Index of the terminator after an encoded string (two zero bytes, aligned, for UTF-16). */
function terminator(b: Uint8Array, from: number, enc: number) {
  if (enc === 1 || enc === 2) {
    for (let i = from; i + 1 < b.length; i += 2) if (b[i] === 0 && b[i + 1] === 0) return i;
    return b.length;
  }
  const i = b.indexOf(0, from);
  return i === -1 ? b.length : i;
}

const toDataUrl = (mime: string, data: Uint8Array) => {
  let s = '';
  for (let i = 0; i < data.length; i += 0x8000) s += String.fromCharCode(...data.subarray(i, i + 0x8000));
  return `data:${mime || 'image/jpeg'};base64,${btoa(s)}`;
};

function readId3(b: Uint8Array): AudioTags | null {
  if (b[0] !== 0x49 || b[1] !== 0x44 || b[2] !== 0x33) return null;
  const major = b[3];
  const end = Math.min(b.length, 10 + syncsafe(b, 6));
  const tags: AudioTags = {};
  let o = 10;
  if (b[5] & 0x40) o += major === 4 ? syncsafe(b, o) : be32(b, o) + 4; // extended header
  const idLen = major === 2 ? 3 : 4;
  const headLen = major === 2 ? 6 : 10;
  while (o + headLen <= end) {
    const id = String.fromCharCode(...b.subarray(o, o + idLen));
    if (!/^[A-Z0-9]+$/.test(id)) break;
    const size = major === 2 ? (b[o + 3] << 16) | (b[o + 4] << 8) | b[o + 5] : major === 4 ? syncsafe(b, o + 4) : be32(b, o + 4);
    const body = b.subarray(o + headLen, Math.min(end, o + headLen + size));
    o += headLen + size;
    if (!body.length) continue;
    const enc = body[0];
    if (id === 'APIC' || id === 'PIC') {
      let p = 1;
      let mime = 'image/jpeg';
      if (id === 'APIC') {
        const m = body.indexOf(0, p);
        mime = new TextDecoder('latin1').decode(body.subarray(p, m));
        p = m + 1;
      } else {
        mime = new TextDecoder('latin1').decode(body.subarray(1, 4)).toLowerCase() === 'png' ? 'image/png' : 'image/jpeg';
        p = 4;
      }
      const type = body[p];
      p = terminator(body, p + 1, enc) + (enc === 1 || enc === 2 ? 2 : 1);
      // Front cover wins; otherwise the first picture.
      if (!tags.picture || type === 3) tags.picture = toDataUrl(mime.includes('/') ? mime : `image/${mime || 'jpeg'}`, body.subarray(p));
      continue;
    }
    if (id === 'COMM' || id === 'COM') {
      const desc = terminator(body, 4, enc);
      tags.comment ??= decodeId3Text(body.subarray(desc + (enc === 1 || enc === 2 ? 2 : 1)), enc);
      continue;
    }
    if (id === 'TXXX') {
      const descEnd = terminator(body, 1, enc);
      const desc = decodeId3Text(body.subarray(1, descEnd), enc).toUpperCase();
      const value = decodeId3Text(body.subarray(descEnd + (enc === 1 || enc === 2 ? 2 : 1)), enc);
      const key = VORBIS[desc.replace(/\s+/g, '')];
      if (key && !tags[key]) tags[key] = value;
      continue;
    }
    const key = ID3_FRAMES[id];
    if (key && id.startsWith('T')) tags[key] = decodeId3Text(body.subarray(1), enc);
  }
  return tags;
}

function readFlac(b: Uint8Array): AudioTags | null {
  if (String.fromCharCode(...b.subarray(0, 4)) !== 'fLaC') return null;
  const tags: AudioTags = {};
  let o = 4;
  for (let last = false; !last && o + 4 <= b.length; ) {
    last = (b[o] & 0x80) !== 0;
    const type = b[o] & 0x7f;
    const len = (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3];
    const body = b.subarray(o + 4, o + 4 + len);
    o += 4 + len;
    if (type === 4) {
      let p = 4 + le32(body, 0);
      const n = le32(body, p);
      p += 4;
      for (let i = 0; i < n && p + 4 <= body.length; i++) {
        const l = le32(body, p);
        const entry = new TextDecoder().decode(body.subarray(p + 4, p + 4 + l));
        p += 4 + l;
        const eq = entry.indexOf('=');
        const key = VORBIS[entry.slice(0, eq).toUpperCase()];
        if (key && !tags[key]) tags[key] = entry.slice(eq + 1).trim();
      }
    } else if (type === 6) {
      const picType = be32(body, 0);
      const mimeLen = be32(body, 4);
      const mime = new TextDecoder('latin1').decode(body.subarray(8, 8 + mimeLen));
      let p = 8 + mimeLen;
      p += 4 + be32(body, p) + 16; // description, then width/height/depth/colours
      const dataLen = be32(body, p);
      if (!tags.picture || picType === 3) tags.picture = toDataUrl(mime, body.subarray(p + 4, p + 4 + dataLen));
    }
  }
  return tags;
}

export function readTags(buf: ArrayBuffer): AudioTags | null {
  const b = new Uint8Array(buf);
  try {
    const tags = readId3(b) ?? readFlac(b);
    return tags && Object.keys(tags).length ? tags : null;
  } catch {
    return null;
  }
}

/** Loudest point per column, across channels, for drawing. */
export function peaksOf(audio: AudioBuffer, columns: number): Float32Array {
  const out = new Float32Array(columns);
  const per = audio.length / columns;
  for (let ch = 0; ch < audio.numberOfChannels; ch++) {
    const data = audio.getChannelData(ch);
    for (let c = 0; c < columns; c++) {
      const start = Math.floor(c * per);
      const end = Math.min(data.length, Math.floor((c + 1) * per));
      // Every sample in short files; a stride in long ones (a peak is still caught at this density).
      const stride = Math.max(1, Math.floor((end - start) / 2000));
      let m = out[c];
      for (let i = start; i < end; i += stride) {
        const v = Math.abs(data[i]);
        if (v > m) m = v;
      }
      out[c] = m;
    }
  }
  return out;
}

type Biquad = { b0: number; b1: number; b2: number; a1: number; a2: number };

/**
 * The two K-weighting filters of BS.1770 for any sample rate (high shelf,
 * then high pass), designed as libebur128 does so that at 48 kHz they are the
 * standard's own coefficients.
 */
function kWeighting(fs: number): [Biquad, Biquad] {
  const shelf = (() => {
    const f0 = 1681.974450955533;
    const G = 3.999843853973347;
    const Q = 0.7071752369554196;
    const K = Math.tan((Math.PI * f0) / fs);
    const Vh = 10 ** (G / 20);
    const Vb = Vh ** 0.4996667741545416;
    const a0 = 1 + K / Q + K * K;
    return { b0: (Vh + (Vb * K) / Q + K * K) / a0, b1: (2 * (K * K - Vh)) / a0, b2: (Vh - (Vb * K) / Q + K * K) / a0, a1: (2 * (K * K - 1)) / a0, a2: (1 - K / Q + K * K) / a0 };
  })();
  const pass = (() => {
    const f0 = 38.13547087602444;
    const Q = 0.5003270373238773;
    const K = Math.tan((Math.PI * f0) / fs);
    const a0 = 1 + K / Q + K * K;
    return { b0: 1, b1: -2, b2: 1, a1: (2 * (K * K - 1)) / a0, a2: (1 - K / Q + K * K) / a0 };
  })();
  return [shelf, pass];
}

export type Levels = { peakDb: number; rmsDb: number; lufs: number | null };

const db = (v: number) => (v > 0 ? 20 * Math.log10(v) : -Infinity);

/** Sample peak and RMS in dBFS, and integrated loudness in LUFS (gated, 400 ms blocks with 75% overlap). */
export function levelsOf(audio: AudioBuffer): Levels {
  const fs = audio.sampleRate;
  const step = Math.round(fs * 0.1);
  const segments = Math.floor(audio.length / step);
  const [f1, f2] = kWeighting(fs);
  // Energy per 100 ms segment, summed over channels with their BS.1770 weights.
  const energy = new Float64Array(segments);
  let peak = 0;
  let sumSq = 0;
  for (let ch = 0; ch < audio.numberOfChannels; ch++) {
    // Surrounds count 1.41×, the LFE not at all (Web Audio orders 5.1 as L R C LFE Ls Rs, quad as L R Ls Rs).
    const n = audio.numberOfChannels;
    const weight = n === 6 ? [1, 1, 1, 0, 1.41, 1.41][ch] : n === 4 ? [1, 1, 1.41, 1.41][ch] : 1;
    const x = audio.getChannelData(ch);
    let x1 = 0, x2 = 0, y1 = 0, y2 = 0, z1 = 0, z2 = 0;
    for (let s = 0; s < segments; s++) {
      let acc = 0;
      const end = (s + 1) * step;
      for (let i = s * step; i < end; i++) {
        const v = x[i];
        const a = Math.abs(v);
        if (a > peak) peak = a;
        sumSq += v * v;
        const y = f1.b0 * v + f1.b1 * x1 + f1.b2 * x2 - f1.a1 * y1 - f1.a2 * y2;
        x2 = x1;
        x1 = v;
        const z = f2.b0 * y + f2.b1 * y1 + f2.b2 * y2 - f2.a1 * z1 - f2.a2 * z2;
        y2 = y1;
        y1 = y;
        z2 = z1;
        z1 = z;
        acc += z * z;
      }
      energy[s] += weight * acc;
    }
  }
  const blocks: number[] = [];
  for (let s = 0; s + 4 <= segments; s++) blocks.push((energy[s] + energy[s + 1] + energy[s + 2] + energy[s + 3]) / (4 * step));
  const loud = (z: number) => -0.691 + 10 * Math.log10(z);
  const abs = blocks.filter((z) => loud(z) > -70);
  let lufs: number | null = null;
  if (abs.length) {
    const relGate = loud(abs.reduce((a, z) => a + z, 0) / abs.length) - 10;
    const rel = abs.filter((z) => loud(z) > relGate);
    if (rel.length) lufs = loud(rel.reduce((a, z) => a + z, 0) / rel.length);
  }
  return { peakDb: db(peak), rmsDb: db(Math.sqrt(sumSq / (audio.length * audio.numberOfChannels))), lufs };
}
