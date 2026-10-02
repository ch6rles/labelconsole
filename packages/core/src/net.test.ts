import type { LookupFunction } from 'node:net';
import { describe, expect, it } from 'vitest';
import { fetchPublicFile, isPublicAddress, isPublicHttps, publicOnlyLookup } from './net';

/** A resolver that answers every name with the given addresses. */
const resolvesTo =
  (...addresses: string[]): LookupFunction =>
  (_host, _opts, cb) =>
    (cb as unknown as (e: null, a: Array<{ address: string; family: number }>) => void)(null, addresses.map((address) => ({ address, family: address.includes(':') ? 6 : 4 })));

describe('public address checks', () => {
  it('tells public addresses from internal ones', () => {
    for (const ip of ['8.8.8.8', '151.101.1.69', '2606:4700::6810:84e5', '::ffff:8.8.8.8']) expect(isPublicAddress(ip), ip).toBe(true);
    for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1', '::1', '::', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1', '::ffff:10.0.0.1', 'not-an-ip'])
      expect(isPublicAddress(ip), ip).toBe(false);
  });

  it('accepts only https links that are not obviously internal', () => {
    expect(isPublicHttps('https://p16-sign.tiktokcdn-us.com/a.jpeg?x=1')).toBe(true);
    expect(isPublicHttps('https://fcbarcelona.com/logo.png')).toBe(true);
    expect(isPublicHttps('http://example.com/a.png')).toBe(false);
    expect(isPublicHttps('https://metadata.google.internal/')).toBe(false);
    expect(isPublicHttps('https://printer.local/')).toBe(false);
    expect(isPublicHttps('https://[fd00::1]/')).toBe(false);
    expect(isPublicHttps('https://127.0.0.1/')).toBe(false);
    expect(isPublicHttps('file:///etc/passwd')).toBe(false);
  });

  it('refuses names that resolve to internal addresses at connect time', async () => {
    const answer = (lookup: LookupFunction) =>
      new Promise<string>((resolve) => lookup('cdn.example.com', {}, (err, address) => resolve(err ? `error: ${err.message}` : String(address))));
    expect(await answer(publicOnlyLookup(resolvesTo('93.184.216.34')))).toBe('93.184.216.34');
    expect(await answer(publicOnlyLookup(resolvesTo('93.184.216.34', '10.0.0.7')))).toMatch(/does not resolve to a public address/);
  });
});

describe('fetchPublicFile', () => {
  const opts = { accept: /^image\//, maxBytes: 1024 };

  it('rejects plain http and internal hosts before connecting', async () => {
    await expect(fetchPublicFile('http://example.com/a.png', opts)).rejects.toThrow(/Only public https/);
    await expect(fetchPublicFile('https://169.254.169.254/latest/meta-data', opts)).rejects.toThrow(/Only public https/);
    await expect(fetchPublicFile('https://localhost/a.png', opts)).rejects.toThrow(/Only public https/);
  });

  it('rejects a public-looking name that resolves to this machine (DNS rebinding)', async () => {
    await expect(fetchPublicFile('https://images.example.com/a.png', { ...opts, lookup: resolvesTo('127.0.0.1') })).rejects.toThrow(/does not resolve to a public address/);
  });
});
