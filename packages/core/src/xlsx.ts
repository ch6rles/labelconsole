import { inflateRawSync } from 'node:zlib';

/**
 * A small reader for .xlsx workbooks (Office Open XML spreadsheets), enough to
 * read each sheet's rows as text, numbers and dates. Distributors export
 * statements this way. Formatting is ignored, formulas are read from their
 * saved values, and date cells come back as YYYY-MM-DD.
 *
 * Old binary .xls files are a different format and are not read.
 */
export type Cell = string | number | boolean | null;
export type Sheet = { name: string; rows: Cell[][] };

/** No single part of a workbook may unpack beyond this (guards against zip bombs). */
const MAX_PART_BYTES = 256 * 1024 * 1024;

export const isXlsx = (body: Buffer) => body.length > 4 && body.readUInt32LE(0) === 0x04034b50;

/** The parts of a zip archive by name, unpacked on demand. */
function unzip(buf: Buffer): Map<string, () => Buffer> {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('This is not an .xlsx file (it has no zip directory)');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  if (count === 0xffff || p === 0xffffffff) throw new Error('This spreadsheet is too large to read; export it as CSV instead');
  const parts = new Map<string, () => Buffer>();
  for (let n = 0; n < count; n++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) throw new Error('This .xlsx file is damaged');
    const method = buf.readUInt16LE(p + 10);
    const compressed = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    p += 46 + nameLen + buf.readUInt16LE(p + 30) + buf.readUInt16LE(p + 32);
    parts.set(name, () => {
      if (buf.readUInt32LE(local) !== 0x04034b50) throw new Error('This .xlsx file is damaged');
      if (size > MAX_PART_BYTES) throw new Error('This spreadsheet is too large to read; export it as CSV instead');
      const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
      const data = buf.subarray(start, start + compressed);
      if (method === 0) return data;
      if (method === 8) return inflateRawSync(data, { maxOutputLength: MAX_PART_BYTES });
      throw new Error(`This .xlsx file uses an unsupported compression (method ${method})`);
    });
  }
  return parts;
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const decode = (s: string) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) =>
    e[0] === '#' ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : (ENTITIES[e] ?? m),
  );
const attr = (tag: string, name: string) => {
  const m = tag.match(new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`));
  return m ? decode(m[1] ?? m[2]) : null;
};
/** All text runs inside an element, without phonetic hints. Tags may carry a namespace prefix. */
const textOf = (xml: string) =>
  [...xml.replace(/<(\w+:)?rPh\b[\s\S]*?<\/(\w+:)?rPh>/g, '').matchAll(/<(?:\w+:)?t\b[^>]*\/>|<(?:\w+:)?t\b[^>]*>([\s\S]*?)<\/(?:\w+:)?t>/g)].map((m) => decode(m[1] ?? '')).join('');

/** Column index from a cell reference: "A1" → 0, "AB12" → 27. */
function columnIndex(ref: string) {
  let n = 0;
  for (const ch of ref) {
    const c = ch.charCodeAt(0);
    if (c < 65 || c > 90) break;
    n = n * 26 + c - 64;
  }
  return n - 1;
}

/** Built-in number formats that show a date (ECMA-376 §18.8.30, plus the common locale ones). */
const DATE_FORMAT_IDS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 45, 46, 47, 50, 51, 52, 53, 54, 55, 56, 57, 58]);
const isDateFormat = (code: string) => /[dmyhs]/i.test(code.replace(/"[^"]*"|\[[^\]]*\]|\\./g, '').replace(/general/gi, ''));

/** Which cell styles display a date, by style index. */
function dateStyles(xml: string | null): Set<number> {
  const out = new Set<number>();
  if (!xml) return out;
  const custom = new Map<number, string>();
  for (const m of xml.matchAll(/<(?:\w+:)?numFmt\b([^>]*)\/?>/g)) custom.set(Number(attr(m[1], 'numFmtId')), attr(m[1], 'formatCode') ?? '');
  const xfs = xml.match(/<(?:\w+:)?cellXfs\b[^>]*>([\s\S]*?)<\/(?:\w+:)?cellXfs>/)?.[1] ?? '';
  [...xfs.matchAll(/<(?:\w+:)?xf\b([^>]*?)(?:\/>|>)/g)].forEach((m, i) => {
    const id = Number(attr(m[1], 'numFmtId') ?? 0);
    if (DATE_FORMAT_IDS.has(id) || (custom.has(id) && isDateFormat(custom.get(id)!))) out.add(i);
  });
  return out;
}

/** A date serial as YYYY-MM-DD (time of day dropped). */
function serialToDate(serial: number, date1904: boolean) {
  const base = date1904 ? Date.UTC(1904, 0, 1) : Date.UTC(1899, 11, 30);
  return new Date(base + Math.floor(serial) * 86_400_000).toISOString().slice(0, 10);
}

/** Every sheet in the workbook, in tab order, as rows of cells (blank rows kept as empty arrays). */
export function readXlsx(body: Buffer): Sheet[] {
  const parts = unzip(body);
  const read = (name: string) => {
    const get = parts.get(name);
    return get ? get().toString('utf8') : null;
  };
  const workbook = read('xl/workbook.xml');
  if (!workbook) throw new Error('This .xlsx file has no workbook in it');
  const date1904 = /date1904\s*=\s*["'](1|true)["']/.test(workbook);
  const shared = [...(read('xl/sharedStrings.xml') ?? '').matchAll(/<(?:\w+:)?si\b[^>]*\/>|<(?:\w+:)?si\b[^>]*>([\s\S]*?)<\/(?:\w+:)?si>/g)].map((m) => textOf(m[1] ?? ''));
  const dates = dateStyles(read('xl/styles.xml'));
  const rels = new Map<string, string>();
  for (const m of (read('xl/_rels/workbook.xml.rels') ?? '').matchAll(/<(?:\w+:)?Relationship\b([^>]*)\/?>/g)) {
    const id = attr(m[1], 'Id');
    const target = attr(m[1], 'Target');
    if (id && target) rels.set(id, target.startsWith('/') ? target.slice(1) : `xl/${target.replace(/^\.\//, '')}`);
  }

  const sheets: Sheet[] = [];
  for (const m of workbook.matchAll(/<(?:\w+:)?sheet\b([^>]*)\/?>/g)) {
    const name = attr(m[1], 'name') ?? `Sheet${sheets.length + 1}`;
    const rid = m[1].match(/\b(?:\w+:)?id\s*=\s*["']([^"']+)["']/)?.[1];
    const xml = rid && rels.get(rid) ? read(rels.get(rid)!) : null;
    if (!xml) continue;
    const rows: Cell[][] = [];
    let nextRow = 0;
    for (const r of xml.matchAll(/<(?:\w+:)?row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:\w+:)?row>)/g)) {
      const at = Number(attr(r[1], 'r')) || nextRow + 1;
      nextRow = at;
      const row: Cell[] = [];
      let nextCol = 0;
      for (const c of (r[2] ?? '').matchAll(/<(?:\w+:)?c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:\w+:)?c>)/g)) {
        const ref = attr(c[1], 'r');
        const col = ref ? columnIndex(ref) : nextCol;
        nextCol = col + 1;
        const inner = c[2] ?? '';
        const type = attr(c[1], 't');
        const v = inner.match(/<(?:\w+:)?v\b[^>]*>([\s\S]*?)<\/(?:\w+:)?v>/)?.[1];
        let value: Cell = null;
        if (type === 'inlineStr') value = textOf(inner.match(/<(?:\w+:)?is\b[^>]*>([\s\S]*?)<\/(?:\w+:)?is>/)?.[1] ?? '');
        else if (v === undefined) value = null;
        else if (type === 's') value = shared[Number(v)] ?? null;
        else if (type === 'str' || type === 'd') value = decode(v);
        else if (type === 'b') value = v.trim() === '1';
        else if (type === 'e') value = null;
        else {
          const n = Number(v);
          value = Number.isFinite(n) ? (dates.has(Number(attr(c[1], 's') ?? -1)) ? serialToDate(n, date1904) : n) : decode(v);
        }
        if (value !== null && value !== '') row[col] = value;
      }
      for (let i = 0; i < row.length; i++) if (row[i] === undefined) row[i] = null;
      rows[at - 1] = row;
    }
    for (let i = 0; i < rows.length; i++) if (!rows[i]) rows[i] = [];
    sheets.push({ name, rows });
  }
  if (sheets.length === 0) throw new Error('This .xlsx file has no sheets with data');
  return sheets;
}
