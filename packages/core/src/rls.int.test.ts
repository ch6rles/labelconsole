import { eq, sql } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import { artists } from '@labelconsole/people/schema';
import { makeOrg } from '../../../test/helpers';
import { closeDb, systemDb } from './db/client';
import { auditLog, memberships, organizations, users } from './db/schema';

afterAll(async () => {
  await closeDb();
});

describe('tenant isolation (Postgres RLS)', () => {
  it('two labels cannot see each other\'s rows', async () => {
    const a = await makeOrg('Label A');
    const b = await makeOrg('Label B');

    const [mara] = await a.as((ctx) => ctx.tx.insert(artists).values({ name: 'Mara Ellis', status: 'active' }).returning());
    expect(mara.orgId).toBe(a.org.id);
    expect(mara.createdBy).toBe(`user:${a.user.id}`);

    const seenByB = await b.as((ctx) => ctx.tx.select().from(artists));
    expect(seenByB).toHaveLength(0);
    const seenByA = await a.as((ctx) => ctx.tx.select().from(artists));
    expect(seenByA.map((r) => r.id)).toEqual([mara.id]);
  });

  it('rejects writes that claim another org id', async () => {
    const a = await makeOrg();
    const b = await makeOrg();
    const err = await b.as((ctx) => ctx.tx.insert(artists).values({ orgId: a.org.id, name: 'Smuggled' })).catch((e) => e);
    expect(String((err as Error & { cause?: Error }).cause?.message ?? err)).toMatch(/row-level security/);
  });

  it('updates and deletes across tenants touch nothing', async () => {
    const a = await makeOrg();
    const b = await makeOrg();
    const [row] = await a.as((ctx) => ctx.tx.insert(artists).values({ name: 'Oskar Lind' }).returning());
    const updated = await b.as((ctx) => ctx.tx.update(artists).set({ name: 'Hijacked' }).where(eq(artists.id, row.id)).returning());
    expect(updated).toHaveLength(0);
    const deleted = await b.as((ctx) => ctx.tx.delete(artists).where(eq(artists.id, row.id)).returning());
    expect(deleted).toHaveLength(0);
    const [still] = await systemDb().select().from(artists).where(eq(artists.id, row.id));
    expect(still.name).toBe('Oskar Lind');
  });

  it('sees nothing at all without an org context', async () => {
    const a = await makeOrg();
    await a.as((ctx) => ctx.tx.insert(artists).values({ name: 'No Context' }));
    const { appDb } = await import('./db/client');
    const rows = await appDb().select().from(artists);
    expect(rows).toHaveLength(0);
  });

  it('limits identity tables to the current label', async () => {
    const a = await makeOrg();
    const b = await makeOrg();
    const visibleUsers = await a.as((ctx) => ctx.tx.select({ id: users.id }).from(users));
    expect(visibleUsers.map((u) => u.id)).toContain(a.user.id);
    expect(visibleUsers.map((u) => u.id)).not.toContain(b.user.id);
    const visibleOrgs = await a.as((ctx) => ctx.tx.select({ id: organizations.id }).from(organizations));
    expect(visibleOrgs.map((o) => o.id)).toEqual([a.org.id]);
    const visibleMemberships = await a.as((ctx) => ctx.tx.select().from(memberships));
    expect(visibleMemberships.every((m) => m.orgId === a.org.id)).toBe(true);
  });

  it('every table with org_id has RLS enabled and a policy', async () => {
    const rows = await systemDb().execute(sql`
      select c.relname as table, c.relrowsecurity as rls,
             exists(select 1 from pg_policies p where p.schemaname = 'public' and p.tablename = c.relname) as has_policy
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      join pg_attribute a on a.attrelid = c.oid and a.attname = 'org_id' and not a.attisdropped
      where n.nspname = 'public' and c.relkind in ('r', 'p')`);
    const list = rows as unknown as Array<{ table: string; rls: boolean; has_policy: boolean }>;
    expect(list.length).toBeGreaterThan(40);
    const missing = list.filter((r) => !r.rls || !r.has_policy).map((r) => r.table);
    expect(missing).toEqual([]);
  });

  it('writes an audit diff with only changed fields', async () => {
    const a = await makeOrg();
    await a.as((ctx) =>
      ctx.audit({ action: 'artist.updated', module: 'people', targetType: 'artist', targetId: crypto.randomUUID(), before: { name: 'A', status: 'active', password: 'x' }, after: { name: 'B', status: 'active', password: 'y' } }),
    );
    const [entry] = await a.as((ctx) => ctx.tx.select().from(auditLog));
    expect(entry.before).toEqual({ name: 'A' });
    expect(entry.after).toEqual({ name: 'B' });
    expect(entry.actorType).toBe('user');
  });
});
