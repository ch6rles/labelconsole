/** Formatting helpers shared by server and client components. */

const SYMBOLS: Record<string, string> = { USD: '$', EUR: '€', GBP: '£', JPY: '¥', SEK: 'kr ', AUD: 'A$', CAD: 'C$' };

export function currencySymbol(currency = 'USD') {
  return SYMBOLS[currency] ?? `${currency} `;
}

/** −$1,234.56 style, matching the design (true minus sign). */
export function money(amount: number | null | undefined, currency = 'USD', opts: { decimals?: number } = {}) {
  if (amount == null || Number.isNaN(amount)) return '—';
  const d = opts.decimals ?? 2;
  const s = Math.abs(amount).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
  return `${amount < 0 ? '−' : ''}${currencySymbol(currency)}${s}`;
}

export function moneyCents(cents: number | null | undefined, currency = 'USD', opts: { decimals?: number } = {}) {
  return cents == null ? '—' : money(cents / 100, currency, opts);
}

/** 18.6M, 610K, 940 */
export function compact(n: number | null | undefined, opts: { signed?: boolean } = {}) {
  if (n == null || Number.isNaN(n)) return '—';
  const abs = Math.abs(n);
  const sign = n < 0 ? '−' : opts.signed && n > 0 ? '+' : '';
  const fmt = (v: number, suffix: string) => `${sign}${v >= 100 ? Math.round(v) : Number(v.toFixed(1))}${suffix}`;
  if (abs >= 1e9) return fmt(abs / 1e9, 'B');
  if (abs >= 1e6) return fmt(abs / 1e6, 'M');
  if (abs >= 1e3) return fmt(abs / 1e3, 'K');
  return `${sign}${Math.round(abs).toLocaleString('en-US')}`;
}

export function int(n: number | null | undefined) {
  return n == null ? '—' : Math.round(n).toLocaleString('en-US');
}

export function pct(n: number | null | undefined, opts: { signed?: boolean; decimals?: number } = {}) {
  if (n == null || !Number.isFinite(n)) return '—';
  const v = Number(n.toFixed(opts.decimals ?? 1));
  return `${opts.signed && v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v)}%`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function toDate(d: string | Date | null | undefined): Date | null {
  if (!d) return null;
  if (d instanceof Date) return d;
  // Plain dates (YYYY-MM-DD) are calendar dates, not instants.
  if (/^\d{4}-\d{2}-\d{2}$/.test(d)) {
    const [y, m, day] = d.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, day));
  }
  const parsed = new Date(d);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/** Oct 16, 2026 */
export function date(d: string | Date | null | undefined) {
  const x = toDate(d);
  if (!x) return '—';
  return `${MONTHS[x.getUTCMonth()]} ${x.getUTCDate()}, ${x.getUTCFullYear()}`;
}

/** Oct 16 */
export function shortDate(d: string | Date | null | undefined) {
  const x = toDate(d);
  if (!x) return '—';
  return `${MONTHS[x.getUTCMonth()]} ${x.getUTCDate()}`;
}

export function monthLabel(d: string | Date) {
  const x = toDate(d)!;
  return MONTHS[x.getUTCMonth()];
}

/** 09:42 in UTC (audit log); the UI shows the org timezone label alongside. */
export function time(d: string | Date | null | undefined) {
  const x = toDate(d);
  if (!x) return '';
  return `${String(x.getUTCHours()).padStart(2, '0')}:${String(x.getUTCMinutes()).padStart(2, '0')}`;
}

export function relative(d: string | Date | null | undefined, now = new Date()) {
  const x = toDate(d);
  if (!x) return '—';
  const s = Math.round((now.getTime() - x.getTime()) / 1000);
  const future = s < 0;
  const a = Math.abs(s);
  const f = (v: number, u: string) => (future ? `in ${v} ${u}${v === 1 ? '' : 's'}` : `${v} ${u}${v === 1 ? '' : 's'} ago`);
  if (a < 45) return future ? 'in a moment' : 'Just now';
  if (a < 3600) return f(Math.round(a / 60), 'minute');
  if (a < 86400) return f(Math.round(a / 3600), 'hour');
  if (a < 86400 * 2 && !future) return 'Yesterday';
  if (a < 86400 * 14) return f(Math.round(a / 86400), 'day');
  return shortDate(x);
}

export function daysBetween(a: string | Date, b: string | Date = new Date()) {
  const x = toDate(a)!;
  const y = toDate(b)!;
  return Math.round((y.getTime() - x.getTime()) / 86400000);
}

export function initials(name: string) {
  return name
    .replace(/&/g, '')
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w[0])
    .slice(0, 2)
    .join('')
    .toUpperCase();
}

export function duration(ms: number | null | undefined) {
  if (!ms) return '—';
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export function bytes(n: number | null | undefined) {
  if (n == null) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

export function titleCase(s: string | null | undefined) {
  if (!s) return '—';
  return s.replace(/[_-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

export function usd(n: number | string | null | undefined, decimals = 2) {
  const v = typeof n === 'string' ? Number(n) : n;
  return money(v ?? 0, 'USD', { decimals });
}
