import { createHmac, timingSafeEqual } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { env } from './env';

/**
 * Object storage for audio, artwork, contracts and Drive files. Production uses
 * an S3-compatible bucket (AWS S3 or Cloudflare R2) with presigned URLs. Local
 * development uses a directory on disk with HMAC-signed URLs served by the web
 * app, so the same code paths (upload, signed download, expiry) are exercised.
 */
export interface StorageDriver {
  put(key: string, body: Buffer | Readable, opts: { contentType: string }): Promise<{ size: number }>;
  get(key: string): Promise<Readable>;
  head(key: string): Promise<{ size: number } | null>;
  delete(key: string): Promise<void>;
  /** Remove every object under a prefix (org deletion). */
  deletePrefix(prefix: string): Promise<void>;
  /** Short-lived download URL. */
  signedUrl(key: string, opts: { expiresInSec: number; filename?: string; inline?: boolean }): Promise<string>;
}

export function signStorageToken(key: string, exp: number, disposition: string) {
  return createHmac('sha256', env().SIGNING_SECRET).update(`${key}\n${exp}\n${disposition}`).digest('base64url');
}

export function verifyStorageToken(key: string, exp: number, disposition: string, sig: string) {
  if (!Number.isFinite(exp) || exp < Math.floor(Date.now() / 1000)) return false;
  const expected = Buffer.from(signStorageToken(key, exp, disposition));
  const given = Buffer.from(sig);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

export class LocalDiskDriver implements StorageDriver {
  constructor(private readonly root: string) {}

  private file(key: string) {
    const resolved = path.resolve(this.root, key);
    if (!resolved.startsWith(path.resolve(this.root) + path.sep)) throw new Error('Invalid storage key');
    return resolved;
  }

  async put(key: string, body: Buffer | Readable, _opts: { contentType: string }) {
    const file = this.file(key);
    await mkdir(path.dirname(file), { recursive: true });
    const source = Buffer.isBuffer(body) ? Readable.from(body) : body;
    await pipeline(source, createWriteStream(file));
    const s = await stat(file);
    return { size: s.size };
  }

  async get(key: string) {
    return createReadStream(this.file(key));
  }

  async head(key: string) {
    try {
      const s = await stat(this.file(key));
      return { size: s.size };
    } catch {
      return null;
    }
  }

  async delete(key: string) {
    await rm(this.file(key), { force: true });
  }

  async deletePrefix(prefix: string) {
    await rm(this.file(prefix.replace(/\/+$/, '')), { recursive: true, force: true });
  }

  async signedUrl(key: string, opts: { expiresInSec: number; filename?: string; inline?: boolean }) {
    const exp = Math.floor(Date.now() / 1000) + opts.expiresInSec;
    const disposition = `${opts.inline ? 'inline' : 'attachment'};${opts.filename ?? ''}`;
    const sig = signStorageToken(key, exp, disposition);
    const q = new URLSearchParams({ exp: String(exp), d: disposition, sig });
    return `${env().APP_URL}/api/storage/${key.split('/').map(encodeURIComponent).join('/')}?${q}`;
  }
}

export class S3Driver implements StorageDriver {
  private clientPromise: Promise<{ client: import('@aws-sdk/client-s3').S3Client; sdk: typeof import('@aws-sdk/client-s3') }> | undefined;

  constructor(private readonly bucket: string) {}

  private async s3() {
    if (!this.clientPromise) {
      this.clientPromise = import('@aws-sdk/client-s3').then((sdk) => {
        const e = env();
        const client = new sdk.S3Client({
          region: e.S3_REGION ?? 'auto',
          endpoint: e.S3_ENDPOINT,
          forcePathStyle: Boolean(e.S3_ENDPOINT),
          credentials: e.S3_ACCESS_KEY_ID ? { accessKeyId: e.S3_ACCESS_KEY_ID, secretAccessKey: e.S3_SECRET_ACCESS_KEY ?? '' } : undefined,
        });
        return { client, sdk };
      });
    }
    return this.clientPromise;
  }

  async put(key: string, body: Buffer | Readable, opts: { contentType: string }) {
    const { client, sdk } = await this.s3();
    const buf = Buffer.isBuffer(body) ? body : Buffer.concat(await body.toArray());
    await client.send(new sdk.PutObjectCommand({ Bucket: this.bucket, Key: key, Body: buf, ContentType: opts.contentType }));
    return { size: buf.length };
  }

  async get(key: string) {
    const { client, sdk } = await this.s3();
    const res = await client.send(new sdk.GetObjectCommand({ Bucket: this.bucket, Key: key }));
    return res.Body as Readable;
  }

  async head(key: string) {
    const { client, sdk } = await this.s3();
    try {
      const res = await client.send(new sdk.HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return { size: Number(res.ContentLength ?? 0) };
    } catch {
      return null;
    }
  }

  async delete(key: string) {
    const { client, sdk } = await this.s3();
    await client.send(new sdk.DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }

  async deletePrefix(prefix: string) {
    const { client, sdk } = await this.s3();
    let token: string | undefined;
    do {
      const page = await client.send(new sdk.ListObjectsV2Command({ Bucket: this.bucket, Prefix: prefix, ContinuationToken: token }));
      const keys = (page.Contents ?? []).map((o) => ({ Key: o.Key! }));
      if (keys.length) await client.send(new sdk.DeleteObjectsCommand({ Bucket: this.bucket, Delete: { Objects: keys } }));
      token = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (token);
  }

  async signedUrl(key: string, opts: { expiresInSec: number; filename?: string; inline?: boolean }) {
    const { client, sdk } = await this.s3();
    const { getSignedUrl } = await import('@aws-sdk/s3-request-presigner');
    const disposition = `${opts.inline ? 'inline' : 'attachment'}${opts.filename ? `; filename="${opts.filename.replace(/"/g, '')}"` : ''}`;
    return getSignedUrl(client, new sdk.GetObjectCommand({ Bucket: this.bucket, Key: key, ResponseContentDisposition: disposition }), {
      expiresIn: opts.expiresInSec,
    });
  }
}

let driver: StorageDriver | undefined;

export function storage(): StorageDriver {
  if (!driver) {
    const e = env();
    if (e.STORAGE_DRIVER === 's3') {
      if (!e.S3_BUCKET) throw new Error('S3_BUCKET is required when STORAGE_DRIVER=s3');
      driver = new S3Driver(e.S3_BUCKET);
    } else {
      driver = new LocalDiskDriver(path.resolve(process.env.LC_REPO_ROOT ?? process.cwd(), e.STORAGE_LOCAL_DIR));
    }
  }
  return driver;
}

export function setStorageDriver(d: StorageDriver) {
  driver = d;
}

/** Tenant-prefixed keys so a bucket listing never mixes labels. */
export function storageKey(orgId: string, kind: string, name: string) {
  const safe = name.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(-120);
  return `${orgId}/${kind}/${crypto.randomUUID()}-${safe}`;
}

/** Allowed upload types and size caps (bytes). */
export const UPLOAD_RULES: Record<string, { mimes: RegExp; maxBytes: number }> = {
  audio: { mimes: /^audio\/(mpeg|wav|x-wav|wave|flac|x-flac|aiff|x-aiff|mp4|aac|ogg)$/, maxBytes: 500 * 1024 * 1024 },
  image: { mimes: /^image\/(png|jpeg|webp|gif|tiff)$/, maxBytes: 50 * 1024 * 1024 },
  document: {
    mimes: /^(application\/pdf|text\/csv|text\/plain|application\/vnd\.openxmlformats-officedocument\.(wordprocessingml\.document|spreadsheetml\.sheet)|application\/msword|application\/vnd\.ms-excel)$/,
    maxBytes: 100 * 1024 * 1024,
  },
  any: { mimes: /^(audio|image|video|text)\/|^application\/(pdf|zip|json|vnd\.)/, maxBytes: 2 * 1024 * 1024 * 1024 },
};
