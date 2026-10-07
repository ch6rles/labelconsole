import { inflateRawSync } from 'node:zlib';

/**
 * A small zip reader (Node's zlib plus the archive's central directory): the
 * entries of an archive with their sizes and dates, each unpacked on demand.
 * Office files (.xlsx, .docx, .pptx) are zip archives too.
 */
export type ZipEntry = { name: string; size: number; compressedSize: number; modified: Date | null; directory: boolean; read: () => Buffer };

/** No single entry may unpack beyond this (guards against zip bombs). */
const MAX_ENTRY_BYTES = 256 * 1024 * 1024;

export const isZip = (body: Buffer) => body.length > 4 && body.readUInt32LE(0) === 0x04034b50;

/** MS-DOS date and time fields, as stored in zip headers. */
function dosDate(date: number, time: number) {
  if (!date) return null;
  const d = new Date(Date.UTC(1980 + (date >> 9), ((date >> 5) & 0x0f) - 1, date & 0x1f, time >> 11, (time >> 5) & 0x3f, (time & 0x1f) * 2));
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Every entry by name. `label` names the file in errors ("This .xlsx file is damaged"). */
export function readZip(buf: Buffer, label = 'zip archive'): Map<string, ZipEntry> {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error(`This is not ${/^[aeiou.]/i.test(label) ? 'an' : 'a'} ${label} (it has no zip directory)`);
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  if (count === 0xffff || p === 0xffffffff) throw new Error(`This ${label} is too large to read`);
  const entries = new Map<string, ZipEntry>();
  for (let n = 0; n < count; n++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) throw new Error(`This ${label} is damaged`);
    const method = buf.readUInt16LE(p + 10);
    const time = buf.readUInt16LE(p + 12);
    const date = buf.readUInt16LE(p + 14);
    const compressed = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    p += 46 + nameLen + buf.readUInt16LE(p + 30) + buf.readUInt16LE(p + 32);
    entries.set(name, {
      name,
      size,
      compressedSize: compressed,
      modified: dosDate(date, time),
      directory: name.endsWith('/'),
      read: () => {
        if (buf.readUInt32LE(local) !== 0x04034b50) throw new Error(`This ${label} is damaged`);
        if (size > MAX_ENTRY_BYTES) throw new Error(`This ${label} is too large to read`);
        const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
        const data = buf.subarray(start, start + compressed);
        if (method === 0) return data;
        if (method === 8) return inflateRawSync(data, { maxOutputLength: MAX_ENTRY_BYTES });
        throw new Error(`This ${label} uses an unsupported compression (method ${method})`);
      },
    });
  }
  return entries;
}
