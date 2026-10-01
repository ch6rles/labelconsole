import { createConnection } from 'node:net';
import type { Readable } from 'node:stream';
import { env } from './env';

/**
 * Virus scanning through clamd's INSTREAM protocol. When CLAMAV_HOST is not
 * configured, files are recorded as "skipped" rather than pretending to pass.
 */
export type ScanResult = { status: 'clean' | 'infected' | 'skipped' | 'error'; signature?: string; error?: string };

export async function scanStream(source: Readable): Promise<ScanResult> {
  const host = env().CLAMAV_HOST;
  if (!host) {
    source.resume();
    return { status: 'skipped' };
  }
  return new Promise((resolve) => {
    const sock = createConnection({ host, port: env().CLAMAV_PORT });
    let reply = '';
    sock.setTimeout(120_000, () => {
      sock.destroy();
      resolve({ status: 'error', error: 'clamd timeout' });
    });
    sock.on('error', (err) => resolve({ status: 'error', error: err.message }));
    sock.on('data', (d) => (reply += d.toString()));
    sock.on('end', () => {
      const text = reply.replace(/\0/g, '').trim();
      if (text.endsWith('OK')) resolve({ status: 'clean' });
      else if (text.includes('FOUND')) resolve({ status: 'infected', signature: text.replace(/^stream: /, '').replace(/ FOUND$/, '') });
      else resolve({ status: 'error', error: text || 'empty reply' });
    });
    sock.on('connect', () => {
      sock.write('zINSTREAM\0');
      source.on('data', (chunk: Buffer) => {
        const size = Buffer.alloc(4);
        size.writeUInt32BE(chunk.length, 0);
        sock.write(size);
        sock.write(chunk);
      });
      source.on('end', () => sock.write(Buffer.alloc(4)));
      source.on('error', (err) => {
        sock.destroy();
        resolve({ status: 'error', error: err.message });
      });
    });
  });
}
