import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import type { ServiceContext } from './context';
import type { DbLike } from './db/client';
import { credentials, orgKeys } from './db/schema';
import { env } from './env';
import { ForbiddenError, NotFoundError } from './errors';

/**
 * Credentials vault with envelope encryption.
 *
 *   master key (KMS or env)  ──wraps──▶  per-org data key  ──encrypts──▶  secret
 *
 * Secrets are encrypted with AES-256-GCM under the org's data key. The data key
 * is stored only in wrapped form. Decryption happens only inside the worker
 * process (the place that calls third-party APIs); the web app can store a
 * secret but can never read one back, and no API returns ciphertext.
 */

export interface KeyProvider {
  readonly id: string;
  wrap(dataKey: Buffer): Promise<string>;
  unwrap(wrapped: string): Promise<Buffer>;
}

/** Master key from env. Swap for a KMS-backed provider in production via `setKeyProvider`. */
export class LocalKeyProvider implements KeyProvider {
  readonly id: string;
  private readonly key: Buffer;

  constructor(base64Key: string, id: string) {
    this.key = Buffer.from(base64Key, 'base64');
    if (this.key.length !== 32) throw new Error('VAULT_MASTER_KEY must be 32 bytes, base64 encoded');
    this.id = id;
  }

  async wrap(dataKey: Buffer) {
    return encrypt(this.key, dataKey).join('.');
  }

  async unwrap(wrapped: string) {
    const [iv, tag, ct] = wrapped.split('.');
    return decrypt(this.key, iv, tag, ct);
  }
}

function encrypt(key: Buffer, plaintext: Buffer): [string, string, string] {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return [iv.toString('base64'), cipher.getAuthTag().toString('base64'), ct.toString('base64')];
}

function decrypt(key: Buffer, iv: string, tag: string, ct: string): Buffer {
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(ct, 'base64')), decipher.final()]);
}

let provider: KeyProvider | undefined;

export function keyProvider(): KeyProvider {
  if (!provider) provider = new LocalKeyProvider(env().VAULT_MASTER_KEY, env().VAULT_MASTER_KEY_ID);
  return provider;
}

export function setKeyProvider(p: KeyProvider) {
  provider = p;
  dataKeyCache.clear();
}

const dataKeyCache = new Map<string, { key: Buffer; at: number }>();
const DATA_KEY_TTL_MS = 10 * 60_000;

async function orgDataKey(db: DbLike, orgId: string): Promise<Buffer> {
  const cached = dataKeyCache.get(orgId);
  if (cached && Date.now() - cached.at < DATA_KEY_TTL_MS) return cached.key;
  const [row] = await db.select().from(orgKeys).where(eq(orgKeys.orgId, orgId));
  let key: Buffer;
  if (row) {
    key = await keyProvider().unwrap(row.wrappedKey);
  } else {
    key = randomBytes(32);
    const wrapped = await keyProvider().wrap(key);
    const inserted = await db
      .insert(orgKeys)
      .values({ orgId, wrappedKey: wrapped, masterKeyId: keyProvider().id })
      .onConflictDoNothing()
      .returning();
    if (inserted.length === 0) {
      // Another process created it first; use theirs.
      const [existing] = await db.select().from(orgKeys).where(eq(orgKeys.orgId, orgId));
      key = await keyProvider().unwrap(existing.wrappedKey);
    }
  }
  dataKeyCache.set(orgId, { key, at: Date.now() });
  return key;
}

export type CredentialSummary = {
  id: string;
  provider: string;
  label: string;
  scope: string[];
  metadata: Record<string, unknown>;
  createdAt: Date;
  lastUsedAt: Date | null;
};

const summary = (r: typeof credentials.$inferSelect): CredentialSummary => ({
  id: r.id,
  provider: r.provider,
  label: r.label,
  scope: r.scope,
  metadata: r.metadata,
  createdAt: r.createdAt,
  lastUsedAt: r.lastUsedAt,
});

export async function putCredential(
  ctx: ServiceContext,
  input: { provider: string; label: string; secret: Record<string, string>; scope?: string[]; metadata?: Record<string, unknown> },
): Promise<CredentialSummary> {
  ctx.assert('settings:credentials');
  const key = await orgDataKey(ctx.tx, ctx.orgId);
  const [iv, authTag, ciphertext] = encrypt(key, Buffer.from(JSON.stringify(input.secret), 'utf8'));
  const [row] = await ctx.tx
    .insert(credentials)
    .values({ provider: input.provider, label: input.label, scope: input.scope ?? [], metadata: input.metadata ?? {}, iv, authTag, ciphertext })
    .returning();
  await ctx.audit({ action: 'credential.created', module: 'settings', targetType: 'credential', targetId: row.id, targetLabel: `${row.provider} · ${row.label}` });
  return summary(row);
}

export async function listCredentials(ctx: ServiceContext): Promise<CredentialSummary[]> {
  ctx.assert('settings:read');
  const rows = await ctx.tx.select().from(credentials).where(isNull(credentials.revokedAt));
  return rows.map(summary);
}

export async function revokeCredential(ctx: ServiceContext, id: string) {
  ctx.assert('settings:credentials');
  const [row] = await ctx.tx.update(credentials).set({ revokedAt: new Date(), ciphertext: '', iv: '', authTag: '' }).where(eq(credentials.id, id)).returning();
  if (!row) throw new NotFoundError('Credential');
  await ctx.audit({ action: 'credential.revoked', module: 'settings', targetType: 'credential', targetId: id, targetLabel: `${row.provider} · ${row.label}` });
}

/**
 * What tools and adapters receive: a handle, not a secret. `use` decrypts
 * in memory for the duration of the callback, inside the worker only.
 */
export type CredentialHandle = {
  id: string;
  provider: string;
  label: string;
  metadata: Record<string, unknown>;
  use<T>(fn: (secret: Record<string, string>) => Promise<T>): Promise<T>;
};

export function assertCanDecrypt() {
  if (process.env.LC_PROCESS !== 'worker' && process.env.LC_ALLOW_DECRYPT !== '1') {
    throw new ForbiddenError('Secrets can only be decrypted inside the worker process');
  }
}

export async function getCredentialHandle(ctx: ServiceContext, provider: string): Promise<CredentialHandle | null> {
  const [row] = await ctx.tx
    .select()
    .from(credentials)
    .where(and(eq(credentials.provider, provider), isNull(credentials.revokedAt)))
    .orderBy(credentials.createdAt)
    .limit(1);
  if (!row) return null;
  const orgId = ctx.orgId;
  const tx = ctx.tx;
  return {
    id: row.id,
    provider: row.provider,
    label: row.label,
    metadata: row.metadata,
    async use(fn) {
      assertCanDecrypt();
      const key = await orgDataKey(tx, orgId);
      const secret = JSON.parse(decrypt(key, row.iv, row.authTag, row.ciphertext).toString('utf8')) as Record<string, string>;
      return fn(secret);
    },
  };
}

/** Load and decrypt in one go (worker only) for adapters that need the value outside a transaction. */
export async function readSecret(ctx: ServiceContext, provider: string): Promise<{ id: string; secret: Record<string, string>; metadata: Record<string, unknown> } | null> {
  const handle = await getCredentialHandle(ctx, provider);
  if (!handle) return null;
  const secret = await handle.use(async (s) => s);
  await ctx.tx.update(credentials).set({ lastUsedAt: new Date() }).where(eq(credentials.id, handle.id));
  return { id: handle.id, secret, metadata: handle.metadata };
}

/** Replace the stored secret (e.g. after an OAuth refresh) without exposing it. */
export async function rotateSecret(ctx: ServiceContext, id: string, secret: Record<string, string>) {
  const key = await orgDataKey(ctx.tx, ctx.orgId);
  const [iv, authTag, ciphertext] = encrypt(key, Buffer.from(JSON.stringify(secret), 'utf8'));
  await ctx.tx.update(credentials).set({ iv, authTag, ciphertext }).where(eq(credentials.id, id));
}

/**
 * Prove the vault is readable with the configured master key: every org data
 * key unwraps and every live credential decrypts. Plaintext is discarded and
 * nothing is cached. Used by the restore drill and before master-key changes.
 */
export async function verifyVault(db: DbLike): Promise<{ orgKeys: number; credentials: number; failures: string[] }> {
  assertCanDecrypt();
  const failures: string[] = [];
  const keys = new Map<string, Buffer>();
  const wrapped = await db.select().from(orgKeys);
  for (const k of wrapped) {
    try {
      keys.set(k.orgId, await keyProvider().unwrap(k.wrappedKey));
    } catch {
      failures.push(`org key for ${k.orgId} (master key ${k.masterKeyId}) does not unwrap`);
    }
  }
  const creds = await db.select().from(credentials).where(isNull(credentials.revokedAt));
  for (const c of creds) {
    const key = keys.get(c.orgId);
    try {
      if (!key) throw new Error('no data key');
      decrypt(key, c.iv, c.authTag, c.ciphertext).fill(0);
    } catch {
      failures.push(`credential ${c.id} (${c.provider}) does not decrypt`);
    }
  }
  for (const k of keys.values()) k.fill(0);
  return { orgKeys: wrapped.length, credentials: creds.length, failures };
}
