import Papa from 'papaparse';
import type { StatementSummary } from './schema';

/**
 * Distributor statement parsing. Exports differ per distributor, so columns
 * are found by header name; amounts handle currency symbols and both decimal
 * conventions; periods accept the common month formats.
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

export function mapColumns(headers: string[]) {
  const norm = headers.map(normHeader);
  const out: Partial<Record<keyof typeof HEADERS, string>> = {};
  for (const [key, names] of Object.entries(HEADERS) as Array<[keyof typeof HEADERS, string[]]>) {
    // Earlier names in each list are more specific; prefer exact matches, then prefixes.
    for (const n of names) {
      const i = norm.findIndex((h, idx) => h === n && !Object.values(out).includes(headers[idx]));
      if (i >= 0) {
        out[key] = headers[i];
        break;
      }
    }
    if (!out[key]) {
      for (const n of names) {
        const i = norm.findIndex((h, idx) => h.startsWith(n) && !Object.values(out).includes(headers[idx]));
        if (i >= 0) {
          out[key] = headers[i];
          break;
        }
      }
    }
  }
  return out;
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

/** A month-level period from the formats distributors use. */
export function parsePeriod(raw: unknown): { start: string; end: string } | null {
  const s = String(raw ?? '').trim().toLowerCase();
  if (!s) return null;
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

export function parseStatementCsv(csv: string, defaultCurrency = 'USD'): { lines: ParsedLine[]; columns: ReturnType<typeof mapColumns>; skipped: number } {
  const parsed = Papa.parse<Record<string, string>>(csv.replace(/^﻿/, ''), { header: true, skipEmptyLines: true, dynamicTyping: false });
  const headers = parsed.meta.fields ?? [];
  const cols = mapColumns(headers);
  if (!cols.net && !cols.gross) throw new Error('Could not find a revenue column (looked for net/earnings/royalty/amount)');
  const lines: ParsedLine[] = [];
  let skipped = 0;
  for (const row of parsed.data) {
    const net = parseAmount(cols.net ? row[cols.net] : row[cols.gross!]);
    const gross = cols.gross ? parseAmount(row[cols.gross]) : net;
    const units = Math.round(parseAmount(cols.units ? row[cols.units] : 0));
    const isrc = cols.isrc ? String(row[cols.isrc] ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '') || null : null;
    if (!net && !gross && !units) {
      skipped++;
      continue;
    }
    const p = cols.period ? parsePeriod(row[cols.period]) : null;
    lines.push({
      periodStart: p?.start ?? null,
      periodEnd: p?.end ?? null,
      source: canonicalSource(cols.source ? String(row[cols.source] ?? '') : ''),
      territory: cols.territory ? String(row[cols.territory] ?? '').trim().slice(0, 60) || null : null,
      isrc: isrc && /^[A-Z]{2}[A-Z0-9]{3}\d{7}$/.test(isrc) ? isrc : null,
      upc: cols.upc ? String(row[cols.upc] ?? '').replace(/\D/g, '') || null : null,
      trackTitle: cols.title ? String(row[cols.title] ?? '').trim().slice(0, 300) || null : null,
      units,
      grossCents: Math.round(gross * 100),
      netCents: Math.round(net * 100),
      currency: (cols.currency ? String(row[cols.currency] ?? '').trim().toUpperCase() : '') || defaultCurrency,
    });
  }
  return { lines, columns: cols, skipped };
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
  const negatives = lines.filter((l) => l.netCents < 0);
  if (negatives.length) anomalies.push(`${negatives.length} line${negatives.length === 1 ? '' : 's'} with negative revenue (returns or chargebacks)`);
  if (opts.unmatchedIsrcs) anomalies.push(`${opts.unmatchedIsrcs} ISRC${opts.unmatchedIsrcs === 1 ? '' : 's'} not in the catalogue`);
  const noIsrc = lines.filter((l) => !l.isrc).length;
  if (noIsrc && noIsrc / lines.length > 0.05) anomalies.push(`${noIsrc} lines without an ISRC`);
  const seen = new Set<string>();
  let dupes = 0;
  for (const l of lines) {
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
