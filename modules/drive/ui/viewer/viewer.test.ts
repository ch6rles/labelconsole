import { describe, expect, it } from 'vitest';
import { levelsOf, peaksOf, readTags } from './audio-analysis';
import { highlightLines } from './highlight';
import { columnName, fontInfo, numeric, sniff } from './inspect';

/** A stand-in for the browser's AudioBuffer: just the parts the analysis reads. */
function buffer(channels: Float32Array[], sampleRate: number) {
  return { sampleRate, numberOfChannels: channels.length, length: channels[0].length, duration: channels[0].length / sampleRate, getChannelData: (c: number) => channels[c] } as unknown as AudioBuffer;
}
const sine = (freq: number, amp: number, seconds: number, rate: number) => Float32Array.from({ length: Math.round(seconds * rate) }, (_, i) => amp * Math.sin((2 * Math.PI * freq * i) / rate));

describe('audio levels', () => {
  it('measures a −23 dBFS 1 kHz stereo sine at −23 LUFS (EBU Tech 3341 case 1)', () => {
    for (const rate of [44100, 48000]) {
      const s = sine(1000, 10 ** (-23 / 20), 5, rate);
      const { lufs, peakDb, rmsDb } = levelsOf(buffer([s, s], rate));
      expect(lufs).toBeCloseTo(-23, 1);
      expect(peakDb).toBeCloseTo(-23, 1);
      expect(rmsDb).toBeCloseTo(-26, 0);
    }
  });

  it('reports silence as silence', () => {
    const quiet = new Float32Array(48000);
    expect(levelsOf(buffer([quiet], 48000))).toEqual({ peakDb: -Infinity, rmsDb: -Infinity, lufs: null });
  });

  it('finds the loudest point in each column of the waveform', () => {
    const data = new Float32Array(100);
    data[10] = -0.8;
    data[90] = 0.3;
    expect(Array.from(peaksOf(buffer([data], 100), 2), (v) => Math.round(v * 10) / 10)).toEqual([0.8, 0.3]);
  });
});

describe('audio tags', () => {
  const frame = (id: string, body: Buffer) => {
    const head = Buffer.alloc(10);
    head.write(id, 0, 'latin1');
    head.writeUInt32BE(body.length, 4);
    return Buffer.concat([head, body]);
  };
  const text = (id: string, value: string) => frame(id, Buffer.concat([Buffer.from([3]), Buffer.from(value, 'utf8')]));
  const id3 = (frames: Buffer[]) => {
    const body = Buffer.concat(frames);
    const head = Buffer.from([0x49, 0x44, 0x33, 3, 0, 0, 0, 0, 0, 0]);
    // Syncsafe size.
    head[6] = (body.length >> 21) & 0x7f;
    head[7] = (body.length >> 14) & 0x7f;
    head[8] = (body.length >> 7) & 0x7f;
    head[9] = body.length & 0x7f;
    return Buffer.concat([head, body, Buffer.alloc(32)]);
  };

  it('reads ID3 title, artist, ISRC, BPM, key and the cover picture from an MP3', () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    const apic = frame('APIC', Buffer.concat([Buffer.from([0]), Buffer.from('image/png\0', 'latin1'), Buffer.from([3]), Buffer.from('Cover\0', 'latin1'), png]));
    const buf = id3([text('TIT2', 'Ainsi Bas La Vida'), text('TPE1', 'vexsyn, syxxsec'), text('TSRC', 'QZHN52412345'), text('TBPM', '160'), text('TKEY', 'Am'), apic]);
    const tags = readTags(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length) as ArrayBuffer);
    expect(tags).toMatchObject({ title: 'Ainsi Bas La Vida', artist: 'vexsyn, syxxsec', isrc: 'QZHN52412345', bpm: '160', key: 'Am' });
    expect(tags?.picture).toBe(`data:image/png;base64,${png.toString('base64')}`);
  });

  it('reads Vorbis comments from a FLAC', () => {
    const comments = ['TITLE=Night Drive', 'ISRC=QZHN52400001'].map((c) => Buffer.from(c));
    const vendor = Buffer.from('test');
    const le = (n: number) => {
      const b = Buffer.alloc(4);
      b.writeUInt32LE(n);
      return b;
    };
    const block = Buffer.concat([le(vendor.length), vendor, le(comments.length), ...comments.flatMap((c) => [le(c.length), c])]);
    const head = Buffer.from([0x84, (block.length >> 16) & 0xff, (block.length >> 8) & 0xff, block.length & 0xff]); // last block, type 4
    const buf = Buffer.concat([Buffer.from('fLaC'), head, block]);
    expect(readTags(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length) as ArrayBuffer)).toEqual({ title: 'Night Drive', isrc: 'QZHN52400001' });
  });

  it('finds nothing in a file without tags', () => {
    expect(readTags(new Uint8Array([1, 2, 3, 4]).buffer)).toBeNull();
  });
});

describe('syntax colouring', () => {
  it('colours keywords, strings, numbers and comments, and carries block comments across lines', () => {
    const [line1, line2, line3] = highlightLines(['const n = 42; // answer', '/* open', 'still */ return "x";'], 'js');
    expect(line1).toEqual([
      { text: 'const', type: 'keyword' },
      { text: ' n = ' },
      { text: '42', type: 'number' },
      { text: '; ' },
      { text: '// answer', type: 'comment' },
    ]);
    expect(line2).toEqual([{ text: '/*', type: 'comment' }, { text: ' open', type: 'comment' }]);
    expect(line3.slice(0, 1)).toEqual([{ text: 'still */', type: 'comment' }]);
    expect(line3).toContainEqual({ text: 'return', type: 'keyword' });
    expect(line3).toContainEqual({ text: '"x"', type: 'string' });
  });

  it('tells JSON keys from values and keeps text intact', () => {
    const [line] = highlightLines(['{"isrc": "QZHN52412345", "explicit": false}'], 'json');
    expect(line.map((t) => t.text).join('')).toBe('{"isrc": "QZHN52412345", "explicit": false}');
    expect(line).toContainEqual({ text: '"isrc"', type: 'key' });
    expect(line).toContainEqual({ text: '"QZHN52412345"', type: 'string' });
    expect(line).toContainEqual({ text: 'false', type: 'literal' });
  });

  it('leaves very long lines (minified files) plain', () => {
    const long = 'a'.repeat(3000);
    expect(highlightLines([long], 'js')).toEqual([[{ text: long }]]);
  });
});

describe('file inspection', () => {
  it('recognises common files from their first bytes', () => {
    expect(sniff(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0]))).toMatch(/^Zip/);
    expect(sniff(new Uint8Array(Buffer.from('RIFF\0\0\0\0WAVEfmt ')))).toBe('WAV audio');
    expect(sniff(new Uint8Array(Buffer.from('SQLite format 3\0')))).toBe('SQLite database');
    expect(sniff(new Uint8Array([0x4d, 0x5a, 0x90, 0]))).toMatch(/Windows program/);
    expect(sniff(new Uint8Array([1, 2, 3, 4]))).toBeNull();
  });

  it('reads a font’s family, style and glyph count', () => {
    const strings = [
      [1, 'DejaVu Serif'],
      [2, 'Bold'],
      [5, 'Version 2.37'],
    ] as const;
    const encoded = strings.map(([, s]) => Buffer.from(s, 'utf16le').swap16());
    const name = Buffer.alloc(6 + strings.length * 12);
    name.writeUInt16BE(0, 0);
    name.writeUInt16BE(strings.length, 2);
    name.writeUInt16BE(name.length, 4);
    let offset = 0;
    strings.forEach(([id], i) => {
      const o = 6 + i * 12;
      name.writeUInt16BE(3, o); // Windows
      name.writeUInt16BE(1, o + 2);
      name.writeUInt16BE(0x409, o + 4); // English
      name.writeUInt16BE(id, o + 6);
      name.writeUInt16BE(encoded[i].length, o + 8);
      name.writeUInt16BE(offset, o + 10);
      offset += encoded[i].length;
    });
    const table = Buffer.concat([name, ...encoded]);
    const maxp = Buffer.from([0, 1, 0, 0, 0x0d, 0x05]);
    const view = (b: Buffer) => new DataView(b.buffer, b.byteOffset, b.length);
    expect(fontInfo(new Map([['name', view(table)], ['maxp', view(maxp)]]))).toEqual({ family: 'DejaVu Serif', style: 'Bold', version: 'Version 2.37', glyphs: 3333 });
  });

  it('names spreadsheet columns and reads numbers written as text', () => {
    expect([0, 25, 26, 51, 701, 702].map(columnName)).toEqual(['A', 'Z', 'AA', 'AZ', 'ZZ', 'AAA']);
    expect(numeric(12.5)).toBe(12.5);
    expect(numeric('1,234.50')).toBe(1234.5);
    expect(numeric('$12')).toBe(12);
    expect(numeric('-3e2')).toBe(-300);
    expect(numeric('QZHN52412345')).toBeNull();
    expect(numeric('2026-08-01')).toBeNull();
    expect(numeric('')).toBeNull();
  });
});
