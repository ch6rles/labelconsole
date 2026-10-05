import Papa from 'papaparse';
import { readXlsx, type Cell } from '@labelconsole/core/xlsx';
import type { StatementSummary } from './schema';

/**
 * Distributor statement parsing, from CSV or .xlsx exports. Exports differ
 * per distributor, so the table is found by its header row (which need not be
 * the first row) and columns by header name; amounts handle currency symbols
 * and both decimal conventions; periods accept the common month formats and
 * date ranges such as "2026-06-01 – 2026-07-31".
 */
export type ParsedLine = {
  periodStart: string | null;
  periodEnd: string | null;
  source: string;
  territory: string | null;
  isrc: string | null;
  upc: string | null;
  trackTitle: string | null;
  units: number;
  grossCents: number;
  netCents: number;
  currency: string;
};

const HEADERS: Record<string, string[]> = {
  isrc: ['isrc', 'isrc code', 'track isrc'],
  upc: ['upc', 'ean', 'barcode', 'product upc', 'release upc', 'upc ean'],
  title: ['track title', 'track name', 'song title', 'title', 'track', 'song', 'asset title'],
  source: ['store', 'store name', 'dsp', 'platform', 'service', 'retailer', 'shop', 'channel', 'partner', 'source'],
  territory: ['country', 'territory', 'country code', 'region', 'sale country', 'country of sale'],
  units: ['quantity', 'units', 'streams', 'plays', 'count', 'downloads', 'sales', 'total units', 'qty'],
  net: ['net revenue', 'net', 'earnings', 'net earnings', 'royalty', 'royalties', 'payable', 'net amount', 'amount due', 'earnings usd', 'total earned', 'net payable', 'revenue', 'amount', 'total'],
  gross: ['gross revenue', 'gross', 'gross amount', 'gross earnings', 'retail revenue'],
  currency: ['currency', 'currency code', 'payment currency'],
  period: ['sale month', 'sales month', 'reporting month', 'statement period', 'period', 'month', 'activity period', 'sales period', 'sale date', 'reporting date', 'transaction date', 'date'],
};

const normHeader = (h: string) => h.toLowerCase().replace(/\(.*?\)/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim();

type Column = keyof typeof HEADERS;

/** Which column holds what, by index (two columns can share a header name). */
export function mapColumnIndexes(headers: string[]): Partial<Record<Column, number>> {
  const norm = headers.map(normHeader);
  const out: Partial<Record<Column, number>> = {};
  const taken = (i: number) => Object.values(out).includes(i);
  for (const [key, names] of Object.entries(HEADERS) as Array<[Column, string[]]>) {
    // Earlier names in each list are more specific; prefer exact matches, then prefixes.
    for (const n of names) {
      const i = norm.findIndex((h, idx) => h === n && !taken(idx));
      if (i >= 0) {
        out[key] = i;
        break;
      }
    }
    if (out[key] === undefined) {
      for (const n of names) {
        const i = norm.findIndex((h, idx) => h.startsWith(n) && !taken(idx));
        if (i >= 0) {
          out[key] = i;
          break;
        }
      }
    }
  }
  return out;
}

/** The same mapping by header name. */
export function mapColumns(headers: string[]) {
  return Object.fromEntries(Object.entries(mapColumnIndexes(headers)).map(([k, i]) => [k, headers[i!]])) as Partial<Record<Column, string>>;
}

/** "1.234,56", "1,234.56", "$12.30", "(4.10)" → number */
export function parseAmount(raw: unknown): number {
  if (typeof raw === 'number') return raw;
  let s = String(raw ?? '').trim();
  if (!s) return 0;
  const negative = /^\(.*\)$/.test(s) || s.startsWith('-') || s.endsWith('-');
  s = s.replace(/[^\d.,]/g, '');
  const lastComma = s.lastIndexOf(',');
  const lastDot = s.lastIndexOf('.');
  if (lastComma > lastDot) s = s.replace(/\./g, '').replace(',', '.');
  else s = s.replace(/,/g, '');
  const n = Number(s);
  return Number.isFinite(n) ? (negative ? -n : n) : 0;
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

const iso = (y: number, m: number, d: number) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

/** One calendar day: "2026-06-01", "01/06/2026" (day first unless that can't be), "Jun 01, 2026", "1 June 2026". */
export function parseDay(raw: string): string | null {
  const s = raw.trim().toLowerCase();
  let y = 0;
  let m = 0;
  let d = 0;
  let mm: RegExpMatchArray | null;
  if ((mm = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/))) [y, m, d] = [Number(mm[1]), Number(mm[2]), Number(mm[3])];
  else if ((mm = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/))) [d, m, y] = Number(mm[2]) > 12 ? [Number(mm[2]), Number(mm[1]), Number(mm[3])] : [Number(mm[1]), Number(mm[2]), Number(mm[3])];
  else if ((mm = s.match(/^([a-z]{3})[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})$/))) [m, d, y] = [MONTHS.indexOf(mm[1]) + 1, Number(mm[2]), Number(mm[3])];
  else if ((mm = s.match(/^(\d{1,2})(?:st|nd|rd|th)?\s+([a-z]{3})[a-z]*\.?,?\s+(\d{4})$/))) [d, m, y] = [Number(mm[1]), MONTHS.indexOf(mm[2]) + 1, Number(mm[3])];
  else return null;
  if (m < 1 || m > 12 || d < 1 || d > new Date(Date.UTC(y, m, 0)).getUTCDate()) return null;
  return iso(y, m, d);
}

/**
 * The period a statement line covers: a month in the formats distributors
 * use, or a range of days or months ("2026-06-01 – 2026-07-31", "Jun 01, 2026
 * — Jul 31, 2026", "Jun 2026 - Jul 2026"), which some report over two months.
 */
export function parsePeriod(raw: unknown): { start: string; end: string } | null {
  const s = String(raw ?? '').trim().toLowerCase();
  if (!s) return null;
  const sides = s.split(/\s+(?:to|until|through|thru|-)\s+|\s*[–—]\s*/);
  if (sides.length === 2) {
    const [a, b] = [parseDay(sides[0]), parseDay(sides[1])];
    const [ma, mb] = [a ? null : parsePeriod(sides[0]), b ? null : parsePeriod(sides[1])];
    const start = a ?? ma?.start;
    const end = b ?? mb?.end;
    if (start && end) return start <= end ? { start, end } : { start: b ?? mb!.start, end: a ?? ma!.end };
  }
  let y: number | null = null;
  let m: number | null = null;
  let mm: RegExpMatchArray | null;
  if ((mm = s.match(/^(\d{4})[-/.](\d{1,2})(?:[-/.]\d{1,2})?/))) [y, m] = [Number(mm[1]), Number(mm[2])];
  else if ((mm = s.match(/^(\d{1,2})[-/.](\d{4})$/))) [m, y] = [Number(mm[1]), Number(mm[2])];
  else if ((mm = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})/))) [m, y] = [Number(mm[2]) > 12 ? Number(mm[1]) : Number(mm[2]), Number(mm[3])];
  else if ((mm = s.match(/([a-z]{3})[a-z]*[\s-]+(\d{4})/))) [m, y] = [MONTHS.indexOf(mm[1]) + 1, Number(mm[2])];
  else if ((mm = s.match(/^(\d{4})(\d{2})$/))) [y, m] = [Number(mm[1]), Number(mm[2])];
  if (!y || !m || m < 1 || m > 12) return null;
  const start = `${y}-${String(m).padStart(2, '0')}-01`;
  const end = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
  return { start, end };
}

const SOURCE_ALIASES: Array<[RegExp, string]> = [
  [/spotify/i, 'Spotify'],
  [/apple|itunes/i, 'Apple Music'],
  [/youtube/i, 'YouTube'],
  [/amazon/i, 'Amazon Music'],
  [/deezer/i, 'Deezer'],
  [/tidal/i, 'Tidal'],
  [/tiktok|bytedance|resso/i, 'TikTok'],
  [/facebook|instagram|meta/i, 'Meta'],
  [/soundcloud/i, 'SoundCloud'],
  [/pandora/i, 'Pandora'],
];

export const canonicalSource = (raw: string) => SOURCE_ALIASES.find(([re]) => re.test(raw))?.[1] ?? (raw.trim() || 'Other');

const text = (c: Cell | undefined) => (c === null || c === undefined ? '' : String(c).trim());
const isBlank = (row: Cell[]) => row.every((c) => text(c) === '');
const TOTAL = /^(grand\s+|sub\s*)?totals?\b/i;
const ADJUSTMENT = /\b(rounding|adjustment)\b/i;

/** A table's header row: the first (within the first 50 rows) naming a revenue column and a track or release column. */
function findHeader(rows: Cell[][]) {
  for (let i = 0; i < Math.min(rows.length, 50); i++) {
    const headers = rows[i].map((c) => (typeof c === 'string' ? c : ''));
    if (headers.filter(Boolean).length < 2) continue;
    const cols = mapColumnIndexes(headers);
    if ((cols.net !== undefined || cols.gross !== undefined) && (cols.isrc !== undefined || cols.title !== undefined || cols.upc !== undefined)) {
      return { headerRow: i, cols, score: Object.keys(cols).length };
    }
  }
  return null;
}

export class SummaryReportError extends Error {
  constructor() {
    super('This looks like a summary report: it has totals, but not a line for each track, store and country. Download the detailed (line-by-line) report from your distributor and upload that instead.');
  }
}

/**
 * Statement lines from a sheet's rows. Blank rows, repeated header rows and
 * total rows are skipped (a total would count everything twice); a rounding
 * adjustment is kept as its own line so the net matches the payout. A line
 * without a period of its own takes the statement's period.
 */
export function linesFromRows(rows: Cell[][], defaultCurrency = 'USD'): { lines: ParsedLine[]; columns: Partial<Record<Column, number>>; skipped: number; headerRow: number } {
  const found = findHeader(rows);
  if (!found) throw new Error('Could not find a revenue column (looked for net/earnings/royalty/revenue/amount next to an ISRC or track title)');
  const { headerRow, cols } = found;
  // A formatted summary (title and totals above small tables, no store column) can't give per-track lines.
  if (headerRow > 0 && cols.source === undefined && rows.slice(0, headerRow).some((r) => !isBlank(r))) throw new SummaryReportError();
  const header = rows[headerRow].map(text);
  const get = (row: Cell[], key: Column) => (cols[key] === undefined ? undefined : row[cols[key]!]);
  const lines: ParsedLine[] = [];
  let skipped = 0;
  for (const row of rows.slice(headerRow + 1)) {
    if (isBlank(row)) continue;
    if (row.map(text).join('|') === header.join('|')) continue;
    const net = parseAmount(cols.net !== undefined ? get(row, 'net') : get(row, 'gross'));
    const gross = cols.gross !== undefined ? parseAmount(get(row, 'gross')) : net;
    const units = Math.round(parseAmount(get(row, 'units') ?? 0));
    const rawIsrc = text(get(row, 'isrc')).toUpperCase().replace(/[^A-Z0-9]/g, '');
    const isrc = rawIsrc && /^[A-Z]{2}[A-Z0-9]{3}\d{7}$/.test(rawIsrc) ? rawIsrc : null;
    const label = text(get(row, 'title')) || row.map(text).find(Boolean) || '';
    if ((!net && !gross && !units) || (!isrc && TOTAL.test(label))) {
      skipped++;
      continue;
    }
    const source = text(get(row, 'source'));
    const adjustment = !isrc && !source && !units && ADJUSTMENT.test(label);
    const p = parsePeriod(get(row, 'period'));
    lines.push({
      periodStart: p?.start ?? null,
      periodEnd: p?.end ?? null,
      source: adjustment ? 'Adjustment' : canonicalSource(source),
      territory: text(get(row, 'territory')).slice(0, 60) || null,
      isrc,
      upc: text(get(row, 'upc')).replace(/\D/g, '') || null,
      trackTitle: (adjustment ? label : text(get(row, 'title'))).slice(0, 300) || null,
      units,
      grossCents: Math.round(gross * 100),
      netCents: Math.round(net * 100),
      currency: text(get(row, 'currency')).toUpperCase() || defaultCurrency,
    });
  }
  const periods = new Set(lines.filter((l) => l.periodStart).map((l) => `${l.periodStart}|${l.periodEnd}`));
  if (periods.size === 1) {
    const [start, end] = [...periods][0].split('|');
    for (const l of lines) if (!l.periodStart) Object.assign(l, { periodStart: start, periodEnd: end });
  }
  return { lines, columns: cols, skipped, headerRow };
}

export function parseStatementCsv(csv: string, defaultCurrency = 'USD') {
  const parsed = Papa.parse<string[]>(csv.replace(/^\uFEFF/, ''), { header: false, skipEmptyLines: true, dynamicTyping: false });
  const out = linesFromRows(parsed.data, defaultCurrency);
  return { ...out, columns: Object.fromEntries(Object.entries(out.columns).map(([k, i]) => [k, String(parsed.data[out.headerRow][i!] ?? '')])) as Partial<Record<Column, string>> };
}

/**
 * An .xlsx export: the sheet holding the line-by-line table is used (one with
 * a store column first), whichever tab it is on.
 */
export function parseStatementXlsx(body: Buffer, defaultCurrency = 'USD') {
  const sheets = readXlsx(body);
  const candidates = sheets
    .map((sheet) => ({ sheet, found: findHeader(sheet.rows) }))
    .filter((c): c is { sheet: (typeof sheets)[number]; found: NonNullable<ReturnType<typeof findHeader>> } => Boolean(c.found))
    .sort((a, b) => Number(b.found.cols.source !== undefined) - Number(a.found.cols.source !== undefined) || b.found.score - a.found.score || b.sheet.rows.length - a.sheet.rows.length);
  if (candidates.length === 0) {
    const words = sheets.flatMap((s) => s.rows.slice(0, 40).flat().map(text)).join(' ');
    if (/royalt|total|statement|payout/i.test(words)) throw new SummaryReportError();
    throw new Error('Could not find a revenue column (looked for net/earnings/royalty/revenue/amount next to an ISRC or track title)');
  }
  return { ...linesFromRows(candidates[0].sheet.rows, defaultCurrency), sheet: candidates[0].sheet.name };
}

export function summarize(lines: ParsedLine[], opts: { distributor: string | null; unmatchedIsrcs: number; previousNetCents?: number | null }): StatementSummary {
  const bySource = new Map<string, { netCents: number; units: number }>();
  for (const l of lines) {
    const s = bySource.get(l.source) ?? { netCents: 0, units: 0 };
    s.netCents += l.netCents;
    s.units += l.units;
    bySource.set(l.source, s);
  }
  const periods = lines.map((l) => l.periodStart).filter((x): x is string => Boolean(x)).sort();
  const ends = lines.map((l) => l.periodEnd).filter((x): x is string => Boolean(x)).sort();
  const netCents = lines.reduce((n, l) => n + l.netCents, 0);
  const anomalies: string[] = [];
  const negatives = lines.filter((l) => l.netCents < 0 && l.source !== 'Adjustment');
  if (negatives.length) anomalies.push(`${negatives.length} line${negatives.length === 1 ? '' : 's'} with negative revenue (returns or chargebacks)`);
  if (opts.unmatchedIsrcs) anomalies.push(`${opts.unmatchedIsrcs} ISRC${opts.unmatchedIsrcs === 1 ? '' : 's'} not in the catalogue`);
  const noIsrc = lines.filter((l) => !l.isrc && l.source !== 'Adjustment').length;
  if (noIsrc && noIsrc / lines.length > 0.05) anomalies.push(`${noIsrc} lines without an ISRC`);
  // Stores often split small sales into identical rows (a few plays, a cent), so only rows with real amounts count as duplicates.
  const seen = new Set<string>();
  let dupes = 0;
  for (const l of lines) {
    if (l.units < 50 && Math.abs(l.netCents) < 50) continue;
    const k = `${l.isrc}|${l.source}|${l.territory}|${l.periodStart}|${l.units}|${l.netCents}`;
    if (seen.has(k)) dupes++;
    seen.add(k);
  }
  if (dupes) anomalies.push(`${dupes} duplicate line${dupes === 1 ? '' : 's'}`);
  const freebies = lines.filter((l) => l.units === 0 && l.netCents > 0).length;
  if (freebies > lines.length * 0.1) anomalies.push(`${freebies} lines with revenue but zero units`);
  if (opts.previousNetCents && opts.previousNetCents > 0) {
    const change = (netCents - opts.previousNetCents) / opts.previousNetCents;
    if (change < -0.3) anomalies.push(`Net revenue is ${Math.round(-change * 100)}% below the previous statement`);
    if (change > 1) anomalies.push(`Net revenue is ${Math.round(change * 100)}% above the previous statement`);
  }
  const currencies = new Set(lines.map((l) => l.currency));
  if (currencies.size > 1) anomalies.push(`Mixed currencies: ${[...currencies].join(', ')}`);
  return {
    distributor: opts.distributor,
    periodStart: periods[0] ?? null,
    periodEnd: ends[ends.length - 1] ?? null,
    currency: [...currencies][0] ?? null,
    lineCount: lines.length,
    grossCents: lines.reduce((n, l) => n + l.grossCents, 0),
    netCents,
    units: lines.reduce((n, l) => n + l.units, 0),
    bySource: [...bySource.entries()].map(([source, v]) => ({ source, ...v })).sort((a, b) => b.netCents - a.netCents),
    anomalies,
  };
}
