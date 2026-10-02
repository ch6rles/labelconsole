import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uniqueEmail } from '../../../test/helpers';
import { createSession, ensureOwner, login, setupLabel, setupNeeded, validateSession } from './auth';
import { closeDb, systemDb } from './db/client';
import { memberships, organizations } from './db/schema';
import { ConflictError } from './errors';
import { registerPermissions } from './permissions';

registerPermissions([{ key: 'catalogue:read', description: '' }]);

// Setup only opens on an installation with no label, so this file starts from an empty one.
// Test files run one at a time, and every other file creates the labels it needs.
beforeAll(async () => {
  await systemDb().execute(sql`truncate organizations cascade`);
});
afterAll(async () => {
  await closeDb();
});

describe('single-label installation', () => {
  it('sets up River Of Styxx once, even when two people try at the same moment', async () => {
    expect(await setupNeeded()).toBe(true);
    const attempts = await Promise.allSettled([
      setupLabel({ name: 'First Owner', email: uniqueEmail(), password: 'correct horse battery' }),
      setupLabel({ name: 'Second Owner', email: uniqueEmail(), password: 'correct horse battery' }),
    ]);
    const won = attempts.filter((a) => a.status === 'fulfilled');
    const lost = attempts.filter((a) => a.status === 'rejected');
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(1);
    expect((lost[0] as PromiseRejectedResult).reason).toBeInstanceOf(ConflictError);
    expect(String((lost[0] as PromiseRejectedResult).reason.message)).toMatch(/River Of Styxx is already set up/);

    const { org, user } = (won[0] as PromiseFulfilledResult<Awaited<ReturnType<typeof setupLabel>>>).value;
    expect(org).toMatchObject({ name: 'River Of Styxx', slug: 'river-of-styxx' });
    expect((org.settings as { shortCode?: string }).shortCode).toBe('ROS');
    const [m] = await systemDb().select().from(memberships).where(eq(memberships.userId, user.id));
    expect(m).toMatchObject({ orgId: org.id, role: 'owner', status: 'active' });
    expect(await setupNeeded()).toBe(false);
    expect(await systemDb().select().from(organizations)).toHaveLength(1);

    // Closed for good: nobody else can create a label through setup.
    await expect(setupLabel({ name: 'Late', email: uniqueEmail(), password: 'correct horse battery' })).rejects.toThrow(/already set up/);
  });

  it('the owner command adds an owner to the existing label and resets a forgotten password', async () => {
    const email = uniqueEmail();
    const added = await ensureOwner({ email, name: 'Styxx Owner', password: 'first password 123' });
    expect(added).toMatchObject({ createdLabel: false, createdUser: true });
    expect(added.org.name).toBe('River Of Styxx');
    const [m] = await systemDb().select().from(memberships).where(eq(memberships.userId, added.user.id));
    expect(m).toMatchObject({ orgId: added.org.id, role: 'owner' });

    const { token } = await createSession(added.user.id, added.org.id);
    const reset = await ensureOwner({ email: email.toUpperCase(), password: 'second password 456' });
    expect(reset).toMatchObject({ createdLabel: false, createdUser: false });
    expect(reset.user.name).toBe('Styxx Owner'); // kept when no name is given
    await expect(login(email, 'first password 123')).rejects.toThrow(/incorrect/);
    expect((await login(email, 'second password 456')).id).toBe(added.user.id);
    // A new password signs out every older session.
    expect(await validateSession(token)).toBeNull();
    expect(await systemDb().select().from(organizations)).toHaveLength(1);
  });
});
