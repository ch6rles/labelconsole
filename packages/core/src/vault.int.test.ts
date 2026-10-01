import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeOrg } from '../../../test/helpers';
import { closeDb, systemDb } from './db/client';
import { credentials, orgKeys } from './db/schema';
import { registerPermissions } from './permissions';
import { getCredentialHandle, keyProvider, listCredentials, LocalKeyProvider, putCredential, readSecret, revokeCredential, setKeyProvider, verifyVault } from './vault';

beforeAll(() => registerPermissions([{ key: 'settings:read', description: '' }, { key: 'settings:credentials', description: '', sensitive: true }]));
afterAll(async () => {
  await closeDb();
});

describe('credentials vault', () => {
  it('wraps data keys with the master key', async () => {
    const kp = new LocalKeyProvider(Buffer.alloc(32, 1).toString('base64'), 'k1');
    const dataKey = Buffer.alloc(32, 9);
    const wrapped = await kp.wrap(dataKey);
    expect(wrapped).not.toContain(dataKey.toString('base64'));
    expect((await kp.unwrap(wrapped)).equals(dataKey)).toBe(true);
    expect(() => new LocalKeyProvider('c2hvcnQ=', 'bad')).toThrow(/32 bytes/);
  });

  it('stores secrets encrypted, lists only metadata and decrypts through a handle', async () => {
    const a = await makeOrg();
    const summary = await a.as((ctx) => putCredential(ctx, { provider: 'youtube', label: 'Label YouTube key', secret: { apiKey: 'AIza-secret-123' }, metadata: { project: 'nl' } }));
    expect(JSON.stringify(summary)).not.toContain('AIza');

    const [row] = await systemDb().select().from(credentials).where(eq(credentials.id, summary.id));
    expect(row.ciphertext).not.toContain('AIza');
    const [key] = await systemDb().select().from(orgKeys).where(eq(orgKeys.orgId, a.org.id));
    expect(key.masterKeyId).toBe('test-v1');

    const listed = await a.as((ctx) => listCredentials(ctx));
    expect(listed).toHaveLength(1);
    expect(JSON.stringify(listed)).not.toContain('AIza');

    const secret = await a.as((ctx) => readSecret(ctx, 'youtube'));
    expect(secret?.secret.apiKey).toBe('AIza-secret-123');

    const handle = await a.as((ctx) => getCredentialHandle(ctx, 'youtube'));
    expect(Object.keys(handle!)).not.toContain('secret');
  });

  it('isolates credentials per label and supports revocation', async () => {
    const a = await makeOrg();
    const b = await makeOrg();
    const s = await a.as((ctx) => putCredential(ctx, { provider: 'smtp', label: 'Mail', secret: { password: 'pw' } }));
    expect(await b.as((ctx) => readSecret(ctx, 'smtp'))).toBeNull();
    await a.as((ctx) => revokeCredential(ctx, s.id));
    expect(await a.as((ctx) => readSecret(ctx, 'smtp'))).toBeNull();
  });

  it('refuses decryption outside the worker', async () => {
    const a = await makeOrg();
    await a.as((ctx) => putCredential(ctx, { provider: 'x', label: 'x', secret: { k: 'v' } }));
    const prev = process.env.LC_ALLOW_DECRYPT;
    process.env.LC_ALLOW_DECRYPT = '0';
    try {
      await expect(a.as((ctx) => readSecret(ctx, 'x'))).rejects.toThrow(/worker/);
    } finally {
      process.env.LC_ALLOW_DECRYPT = prev;
    }
  });

  it('verifies every key and credential decrypts, and catches the wrong master key', async () => {
    const a = await makeOrg();
    await a.as((ctx) => putCredential(ctx, { provider: 'youtube', label: 'Drill', secret: { apiKey: 'AIza-verify' } }));
    const ok = await verifyVault(systemDb());
    expect(ok.failures).toEqual([]);
    expect(ok.credentials).toBeGreaterThan(0);

    const real = keyProvider();
    // Any key other than the test master key (which is 32 bytes of 7).
    setKeyProvider(new LocalKeyProvider(Buffer.alloc(32, 3).toString('base64'), 'wrong'));
    try {
      const bad = await verifyVault(systemDb());
      expect(bad.failures.some((f) => f.includes(a.org.id))).toBe(true);
      expect(bad.failures.join(' ')).not.toContain('AIza');
    } finally {
      setKeyProvider(real);
    }
  });
});
