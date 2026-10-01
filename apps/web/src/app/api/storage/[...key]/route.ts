import { Readable } from 'node:stream';
import { storage, verifyStorageToken } from '@labelconsole/core/storage';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** Serves files for the local storage driver from HMAC-signed, expiring URLs (S3 serves its own presigned URLs). */
export async function GET(req: Request, { params }: { params: Promise<{ key: string[] }> }) {
  const { key: parts } = await params;
  const key = parts.map(decodeURIComponent).join('/');
  const url = new URL(req.url);
  const exp = Number(url.searchParams.get('exp'));
  const d = url.searchParams.get('d') ?? '';
  const sig = url.searchParams.get('sig') ?? '';
  if (!verifyStorageToken(key, exp, d, sig)) return new Response('Link expired or invalid', { status: 403 });
  const head = await storage().head(key);
  if (!head) return new Response('Not found', { status: 404 });
  const [kind, filename] = d.split(';');
  const body = Readable.toWeb(await storage().get(key)) as ReadableStream;
  return new Response(body, {
    headers: {
      'content-length': String(head.size),
      'content-type': guessType(filename || key),
      'content-disposition': `${kind === 'inline' ? 'inline' : 'attachment'}${filename ? `; filename="${filename.replace(/"/g, '')}"` : ''}`,
      'cache-control': 'private, max-age=300',
      'x-content-type-options': 'nosniff',
    },
  });
}

function guessType(name: string) {
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  const map: Record<string, string> = {
    pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif',
    mp3: 'audio/mpeg', wav: 'audio/wav', flac: 'audio/flac', aiff: 'audio/aiff', m4a: 'audio/mp4', csv: 'text/csv', txt: 'text/plain', json: 'application/json', zip: 'application/zip',
  };
  return map[ext] ?? 'application/octet-stream';
}
