import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import { request } from 'node:https';
import { isIP, type LookupFunction } from 'node:net';
import { env } from './env';
import { ValidationError } from './errors';

/**
 * Outbound requests to addresses chosen by someone else (a label's webhook
 * URL, an image link an agent found). They may only reach the public
 * internet: never this machine, the private network or cloud metadata.
 */

/** Cheap syntactic check: https, and not a name or literal address that is obviously internal. */
export function isPublicHttps(raw: string) {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.protocol !== 'https:') return false;
  const h = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.internal') || h.endsWith('.local')) return false;
  if (isIP(h)) return isPublicAddress(h);
  return true;
}

/** True for globally routable addresses; false for loopback, private, link-local, CGNAT, multicast and reserved ranges. */
export function isPublicAddress(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) {
    const [a, b] = ip.split('.').map(Number);
    if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
    if (a === 169 && b === 254) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 168) return false;
    if (a === 100 && b >= 64 && b <= 127) return false;
    if (a === 192 && b === 0) return false;
    if (a === 198 && (b === 18 || b === 19)) return false;
    return true;
  }
  if (v === 6) {
    const h = ip.toLowerCase();
    if (h === '::' || h === '::1') return false;
    // IPv4-mapped (::ffff:a.b.c.d) is judged by the IPv4 address it carries.
    const mapped = h.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPublicAddress(mapped[1]);
    if (h.startsWith('::ffff:')) return false;
    if (/^f[cd]/.test(h) || /^fe[89ab]/.test(h) || h.startsWith('ff')) return false;
    return true;
  }
  return false;
}

/**
 * DNS lookup that refuses non-public answers. It runs at connect time, so a
 * name that resolves to a public address when checked and a private one when
 * connecting (DNS rebinding) is still refused.
 */
export function publicOnlyLookup(base: LookupFunction = dnsLookup as unknown as LookupFunction): LookupFunction {
  return (hostname, options, callback) => {
    base(hostname, { ...options, all: true }, (err, addresses) => {
      if (err) return callback(err, '', 4);
      const list = (Array.isArray(addresses) ? addresses : [{ address: addresses as unknown as string, family: 4 }]) as LookupAddress[];
      const bad = list.find((a) => !isPublicAddress(a.address));
      if (bad || list.length === 0) return callback(Object.assign(new Error(`${hostname} does not resolve to a public address`), { code: 'EPUBLICONLY' }), '', 4);
      if ((options as { all?: boolean }).all) return (callback as unknown as (e: null, a: LookupAddress[]) => void)(null, list);
      callback(null, list[0].address, list[0].family);
    });
  };
}

export type PublicFile = { body: Buffer; contentType: string; finalUrl: string };

export type FetchPublicOptions = {
  /** Allowed content types, e.g. /^image\/(png|jpeg)$/. */
  accept: RegExp;
  maxBytes: number;
  timeoutMs?: number;
  maxRedirects?: number;
  signal?: AbortSignal;
  /** Tests resolve names here instead of through DNS. */
  lookup?: LookupFunction;
};

/** GET a file from a public https URL with a size cap, a timeout and re-checked redirects. */
export async function fetchPublicFile(url: string, opts: FetchPublicOptions): Promise<PublicFile> {
  const lookup = publicOnlyLookup(opts.lookup);
  const timeout = AbortSignal.timeout(opts.timeoutMs ?? 20_000);
  const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
  let current = url;
  for (let hop = 0; hop <= (opts.maxRedirects ?? 3); hop++) {
    if (!isPublicHttps(current)) throw new ValidationError(`Only public https:// links can be downloaded (${hostOf(current)})`);
    const res = await get(current, lookup, signal, opts.maxBytes);
    if ('location' in res) {
      current = new URL(res.location, current).toString();
      continue;
    }
    const type = (res.contentType.split(';')[0] ?? '').trim().toLowerCase();
    if (!opts.accept.test(type)) throw new ValidationError(`${hostOf(current)} returned ${type || 'an unknown type'}, not an allowed file type`);
    return { body: res.body, contentType: type, finalUrl: current };
  }
  throw new ValidationError('Too many redirects');
}

const hostOf = (u: string) => {
  try {
    return new URL(u).hostname;
  } catch {
    return 'invalid link';
  }
};

function get(url: string, lookup: LookupFunction, signal: AbortSignal, maxBytes: number): Promise<{ location: string } | { body: Buffer; contentType: string }> {
  return new Promise((resolve, reject) => {
    const req = request(url, { method: 'GET', lookup, signal, headers: { 'user-agent': env().HTTP_USER_AGENT, accept: 'image/*,*/*;q=0.5' } }, (res) => {
      const status = res.statusCode ?? 0;
      if (status >= 300 && status < 400 && res.headers.location) {
        res.resume();
        return resolve({ location: res.headers.location });
      }
      if (status < 200 || status >= 300) {
        res.resume();
        return reject(new ValidationError(`${hostOf(url)} answered ${status}`));
      }
      const declared = Number(res.headers['content-length'] ?? 0);
      if (declared > maxBytes) {
        res.destroy();
        return reject(new ValidationError(`The file is larger than ${Math.round(maxBytes / 1024 / 1024)} MB`));
      }
      const chunks: Buffer[] = [];
      let size = 0;
      res.on('data', (c: Buffer) => {
        size += c.length;
        if (size > maxBytes) {
          res.destroy();
          reject(new ValidationError(`The file is larger than ${Math.round(maxBytes / 1024 / 1024)} MB`));
        } else chunks.push(c);
      });
      res.on('end', () => resolve({ body: Buffer.concat(chunks), contentType: String(res.headers['content-type'] ?? '') }));
      res.on('error', reject);
    });
    req.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EPUBLICONLY') reject(new ValidationError(err.message));
      else if (err.name === 'AbortError') reject(new ValidationError(`${hostOf(url)} took too long to answer`));
      else reject(new ValidationError(`Could not download from ${hostOf(url)}: ${err.message}`));
    });
    req.end();
  });
}
