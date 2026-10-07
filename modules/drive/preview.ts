import Papa from 'papaparse';
import { readXlsx, type Cell } from '@labelconsole/core/xlsx';
import { xmlAttr, xmlDecode } from '@labelconsole/core/xml';
import { readZip } from '@labelconsole/core/zip';
import { extensionOf, type FileKind } from './kinds';

/**
 * What the viewer needs to show a file that browsers can't open on their own:
 * text decoded, spreadsheets as rows, Word documents as HTML, slides as text
 * and pictures, zip archives as a listing. Images, audio, video, PDFs and
 * fonts are shown from the file itself and need no preview.
 */
export type SheetPreview = { name: string; rows: Cell[][]; totalRows: number; totalCols: number; truncated: boolean };
export type SlidePreview = { index: number; title: string | null; paragraphs: Array<{ text: string; level: number }>; images: string[]; notes: string | null };
export type ArchiveEntry = { name: string; size: number; compressedSize: number; modified: string | null; directory: boolean };
export type Preview =
  | { kind: 'text'; text: string; truncated: boolean; encoding: string }
  | { kind: 'sheet'; sheets: SheetPreview[] }
  | { kind: 'document'; html: string }
  | { kind: 'slides'; slides: SlidePreview[]; truncated: boolean }
  | { kind: 'archive'; entries: ArchiveEntry[]; total: number; totalSize: number }
  | { kind: 'binary'; hex: string; bytes: number }
  | { kind: 'unsupported'; reason: string };

/** How much of a file each kind reads at most. */
export const TEXT_BYTES = 1024 * 1024;
export const CSV_BYTES = 10 * 1024 * 1024;
export const OFFICE_BYTES = 40 * 1024 * 1024;
export const ARCHIVE_BYTES = 150 * 1024 * 1024;
export const HEX_BYTES = 2048;
const MAX_ROWS = 5000;
const MAX_COLS = 200;
const MAX_SLIDES = 300;
const MAX_ENTRIES = 5000;
const MAX_IMAGE_BYTES = 3 * 1024 * 1024;
const MAX_DECK_IMAGES_BYTES = 25 * 1024 * 1024;

/** Text in whatever encoding it was saved in: a byte-order mark first, then UTF-8, else Windows-1252. */
export function decodeText(buf: Buffer, complete: boolean): { text: string; encoding: string } {
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return { text: new TextDecoder('utf-8').decode(buf.subarray(3)), encoding: 'UTF-8' };
  if (buf[0] === 0xff && buf[1] === 0xfe) return { text: new TextDecoder('utf-16le').decode(buf.subarray(2)), encoding: 'UTF-16' };
  if (buf[0] === 0xfe && buf[1] === 0xff) return { text: new TextDecoder('utf-16be').decode(buf.subarray(2)), encoding: 'UTF-16' };
  try {
    // A cut-off read may end mid-character; that last character is dropped rather than failing the whole file.
    const text = new TextDecoder('utf-8', { fatal: true }).decode(complete ? buf : trimPartialUtf8(buf));
    return { text, encoding: 'UTF-8' };
  } catch {
    return { text: new TextDecoder('windows-1252').decode(buf), encoding: 'Windows-1252' };
  }
}

function trimPartialUtf8(buf: Buffer) {
  let end = buf.length;
  for (let i = 1; i <= 3 && end - i >= 0; i++) {
    const b = buf[end - i];
    if ((b & 0xc0) === 0x80) continue; // continuation byte
    const need = b >= 0xf0 ? 4 : b >= 0xe0 ? 3 : b >= 0xc0 ? 2 : 1;
    return need > i ? buf.subarray(0, end - i) : buf;
  }
  return buf;
}

export function textPreview(buf: Buffer, complete: boolean): Preview {
  const { text, encoding } = decodeText(buf, complete);
  return { kind: 'text', text: text.replace(/\u0000/g, ''), truncated: !complete, encoding };
}

/** Rows of a sheet, trimmed of empty trailing rows and capped for the browser. */
function sheetOf(name: string, rows: Cell[][], truncatedSource = false): SheetPreview {
  let last = rows.length;
  while (last > 0 && rows[last - 1].every((c) => c === null || c === '')) last--;
  const used = rows.slice(0, last);
  const totalCols = used.reduce((m, r) => Math.max(m, r.length), 0);
  return { name, rows: used.slice(0, MAX_ROWS).map((r) => r.slice(0, MAX_COLS)), totalRows: used.length, totalCols, truncated: truncatedSource || used.length > MAX_ROWS || totalCols > MAX_COLS };
}

export function csvPreview(buf: Buffer, complete: boolean, name: string): Preview {
  const { text } = decodeText(buf, complete);
  const parsed = Papa.parse<string[]>(text, { skipEmptyLines: false, delimiter: extensionOf(name) === 'tsv' ? '\t' : '' });
  const rows = parsed.data as Cell[][];
  // A file cut off mid-way ends with a partial row.
  if (!complete && rows.length > 1) rows.pop();
  return { kind: 'sheet', sheets: [sheetOf(name.replace(/\.[^.]+$/, ''), rows, !complete)] };
}

export function xlsxPreview(buf: Buffer): Preview {
  return { kind: 'sheet', sheets: readXlsx(buf).map((s) => sheetOf(s.name, s.rows)) };
}

/** A Word document as HTML (headings, lists, tables, links and pictures), for a sandboxed frame. */
export async function docxPreview(buf: Buffer): Promise<Preview> {
  const mammoth = await import('mammoth');
  const { value } = await mammoth.convertToHtml({ buffer: buf }, { styleMap: ["p[style-name='Title'] => h1.title:fresh", "p[style-name='Subtitle'] => p.subtitle:fresh"] });
  // Belt and braces: the frame runs no scripts, and links lose any script URL.
  const html = value.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/\shref="\s*javascript:[^"]*"/gi, ' href="#"');
  return { kind: 'document', html };
}

const MEDIA_TYPE: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', bmp: 'image/bmp' };

/** A path relative to a part (as in a .rels file), resolved against the archive root. */
function resolvePart(base: string, target: string) {
  if (target.startsWith('/')) return target.slice(1);
  const parts = base.split('/').slice(0, -1);
  for (const seg of target.split('/')) {
    if (seg === '..') parts.pop();
    else if (seg !== '.') parts.push(seg);
  }
  return parts.join('/');
}

function relsOf(entries: ReturnType<typeof readZip>, part: string) {
  const relsPath = `${part.split('/').slice(0, -1).join('/')}/_rels/${part.split('/').pop()}.rels`;
  const xml = entries.get(relsPath)?.read().toString('utf8') ?? '';
  const out = new Map<string, { target: string; type: string }>();
  for (const m of xml.matchAll(/<(?:\w+:)?Relationship\b([^>]*)\/?>/g)) {
    const id = xmlAttr(m[1], 'Id');
    const target = xmlAttr(m[1], 'Target');
    if (id && target && xmlAttr(m[1], 'TargetMode') !== 'External') out.set(id, { target: resolvePart(part, target), type: xmlAttr(m[1], 'Type') ?? '' });
  }
  return out;
}

/** Paragraphs of a text body: their runs joined, with their list level. */
function paragraphs(xml: string) {
  const out: Array<{ text: string; level: number }> = [];
  for (const p of xml.matchAll(/<a:p\b[^>]*>([\s\S]*?)<\/a:p>/g)) {
    const text = [...p[1].matchAll(/<a:t\b[^>]*>([\s\S]*?)<\/a:t>|<a:br\b[^>]*\/>/g)].map((t) => (t[0].startsWith('<a:br') ? '\n' : xmlDecode(t[1]))).join('');
    if (!text.trim()) continue;
    out.push({ text, level: Number(p[1].match(/<a:pPr\b[^>]*\blvl="(\d+)"/)?.[1] ?? 0) });
  }
  return out;
}

/** A PowerPoint deck's slides: title, text by paragraph, pictures and speaker notes. */
export function pptxPreview(buf: Buffer): Preview {
  const entries = readZip(buf, '.pptx file');
  const presentation = entries.get('ppt/presentation.xml')?.read().toString('utf8');
  if (!presentation) throw new Error('This .pptx file has no slides in it');
  const rels = relsOf(entries, 'ppt/presentation.xml');
  const order = [...presentation.matchAll(/<p:sldId\b([^>]*)\/?>/g)].map((m) => m[1].match(/\br:id="([^"]+)"/)?.[1]).filter((id): id is string => Boolean(id));
  let imageBytes = 0;
  const slides: SlidePreview[] = [];
  for (const [i, rid] of order.slice(0, MAX_SLIDES).entries()) {
    const part = rels.get(rid)?.target;
    const xml = part ? entries.get(part)?.read().toString('utf8') : undefined;
    if (!part || !xml) continue;
    const slideRels = relsOf(entries, part);
    let title: string | null = null;
    const body: Array<{ text: string; level: number }> = [];
    for (const sp of xml.matchAll(/<p:sp\b[^>]*>([\s\S]*?)<\/p:sp>/g)) {
      const paras = paragraphs(sp[1]);
      if (!paras.length) continue;
      if (!title && /<p:ph\b[^>]*type="(title|ctrTitle)"/.test(sp[1])) title = paras.map((p) => p.text).join(' ');
      else body.push(...paras);
    }
    // Text in tables and grouped shapes outside a <p:sp>.
    for (const tbl of xml.matchAll(/<a:tbl\b[^>]*>([\s\S]*?)<\/a:tbl>/g)) body.push(...paragraphs(tbl[1]));
    const images: string[] = [];
    for (const pic of xml.matchAll(/<a:blip\b[^>]*r:embed="([^"]+)"/g)) {
      const target = slideRels.get(pic[1])?.target;
      const type = target ? MEDIA_TYPE[extensionOf(target)] : undefined;
      const entry = target ? entries.get(target) : undefined;
      // Formats browsers can't draw (EMF, WMF, TIFF) and very large pictures are left out.
      if (!type || !entry || entry.size > MAX_IMAGE_BYTES || imageBytes + entry.size > MAX_DECK_IMAGES_BYTES) continue;
      imageBytes += entry.size;
      images.push(`data:${type};base64,${entry.read().toString('base64')}`);
    }
    const notesPart = [...slideRels.values()].find((r) => r.type.endsWith('/notesSlide'))?.target;
    const notesXml = notesPart ? entries.get(notesPart)?.read().toString('utf8') : undefined;
    const notes = notesXml
      ? [...notesXml.matchAll(/<p:sp\b[^>]*>([\s\S]*?)<\/p:sp>/g)]
          .filter((sp) => !/<p:ph\b[^>]*type="(sldNum|sldImg|hdr|ftr|dt)"/.test(sp[1]))
          .flatMap((sp) => paragraphs(sp[1]).map((p) => p.text))
          .join('\n') || null
      : null;
    slides.push({ index: i + 1, title, paragraphs: body, images, notes });
  }
  return { kind: 'slides', slides, truncated: order.length > MAX_SLIDES };
}

export function zipPreview(buf: Buffer): Preview {
  const all = [...readZip(buf).values()].filter((e) => !e.name.startsWith('__MACOSX/') && !e.name.endsWith('.DS_Store'));
  return {
    kind: 'archive',
    total: all.length,
    totalSize: all.reduce((a, e) => a + e.size, 0),
    entries: all.slice(0, MAX_ENTRIES).map((e) => ({ name: e.name, size: e.size, compressedSize: e.compressedSize, modified: e.modified?.toISOString() ?? null, directory: e.directory })),
  };
}

/** Whether bytes of unknown type are text: no NUL bytes and almost no control characters in the first 8 KB. */
export function looksLikeText(buf: Buffer) {
  const head = buf.subarray(0, 8192);
  if (!head.length) return true;
  if (head[0] === 0xff && head[1] === 0xfe) return true; // UTF-16 with a byte-order mark
  if (head[0] === 0xfe && head[1] === 0xff) return true;
  let control = 0;
  for (const b of head) {
    if (b === 0) return false;
    if (b < 0x09 || (b > 0x0d && b < 0x20 && b !== 0x1b)) control++;
  }
  return control / head.length < 0.02;
}

export function hexPreview(buf: Buffer): Preview {
  const head = buf.subarray(0, HEX_BYTES);
  return { kind: 'binary', hex: head.toString('hex'), bytes: head.length };
}

/** What each kind needs read: the start of the file, or all of it (up to a limit). */
export function readPlan(kind: FileKind, name: string): { bytes: number; whole: boolean } {
  if (kind === 'markdown' || kind === 'html' || kind === 'code' || kind === 'text') return { bytes: TEXT_BYTES, whole: false };
  if (kind === 'sheet') return ['csv', 'tsv'].includes(extensionOf(name)) ? { bytes: CSV_BYTES, whole: false } : { bytes: OFFICE_BYTES, whole: true };
  if (kind === 'document' || kind === 'slides') return { bytes: OFFICE_BYTES, whole: true };
  if (kind === 'archive') return { bytes: ARCHIVE_BYTES, whole: true };
  // Unknown types are read as far as text would be, in case they turn out to be text.
  return { bytes: TEXT_BYTES, whole: false };
}

/** The preview for a file's bytes; `complete` says whether they are the whole file. */
export async function buildPreview(kind: FileKind, name: string, buf: Buffer, complete: boolean): Promise<Preview> {
  switch (kind) {
    case 'markdown':
    case 'html':
    case 'code':
    case 'text':
      return textPreview(buf, complete);
    case 'sheet':
      return ['csv', 'tsv'].includes(extensionOf(name)) ? csvPreview(buf, complete, name) : xlsxPreview(buf);
    case 'document':
      return docxPreview(buf);
    case 'slides':
      return pptxPreview(buf);
    case 'archive':
      return zipPreview(buf);
    default:
      return looksLikeText(buf) ? textPreview(buf, complete) : hexPreview(buf);
  }
}
