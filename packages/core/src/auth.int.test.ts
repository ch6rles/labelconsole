import { afterAll, describe, expect, it } from 'vitest';
import { uniqueEmail } from '../../../test/helpers';
import { createOrgForUser, createSession, hashPassword, listUserOrgs, login, revokeSession, signup, switchOrg, validateSession, verifyPassword } from './auth';
import { closeDb } from './db/client';
import { registerPermissions } from './permissions';

registerPermissions([{ key: 'catalogue:read', description: '' }, { key: 'settings:manage', description: '' }]);

afterAll(async () => {
  await closeDb();
});

describe('auth', () => {
  it('hashes and verifies passwords', async () => {
    const h = await hashPassword('a long enough password');
    expect(h.startsWith('scrypt$')).toBe(true);
    expect(await verifyPassword('a long enough password', h)).toBe(true);
    expect(await verifyPassword('wrong password!!', h)).toBe(false);
    await expect(hashPassword('short')).rejects.toThrow(/at least 10/);
  });

  it('signs up a user with an owner membership and an org-aware session', async () => {
    const email = uniqueEmail();
    const { user, org } = await signup({ name: 'Sam Okafor', email, password: 'correct horse battery', labelName: 'Northline Records' });
    expect(org.slug).toMatch(/^northline-records/);
    expect((org.settings as { shortCode?: string }).shortCode).toBe('NR');

    await expect(login(email, 'not the password')).rejects.toThrow(/incorrect/);
    const u = await login(email.toUpperCase(), 'correct horse battery');
    expect(u.id).toBe(user.id);

    const { token } = await createSession(user.id, org.id);
    const s = await validateSession(token);
    expect(s?.org.id).toBe(org.id);
    expect(s?.membership.role).toBe('owner');
    expect(s?.permissions.has('settings:manage')).toBe(true);

    await revokeSession(token);
    expect(await validateSession(token)).toBeNull();
  });

  it('rejects duplicate emails', async () => {
    const email = uniqueEmail();
    await signup({ name: 'A', email, password: 'correct horse battery', labelName: 'L1' });
    await expect(signup({ name: 'B', email, password: 'correct horse battery', labelName: 'L2' })).rejects.toThrow(/already exists/);
  });

  it('switches between labels the user belongs to, and only those', async () => {
    const { user, org } = await signup({ name: 'Multi', email: uniqueEmail(), password: 'correct horse battery', labelName: 'First Label' });
    const second = await createOrgForUser(user.id, 'Second Label');
    const stranger = await signup({ name: 'Other', email: uniqueEmail(), password: 'correct horse battery', labelName: 'Not Yours' });
    expect((await listUserOrgs(user.id)).map((o) => o.name).sort()).toEqual(['First Label', 'Second Label']);

    const { token } = await createSession(user.id, org.id);
    await switchOrg(token, second.id);
    expect((await validateSession(token))?.org.id).toBe(second.id);
    await expect(switchOrg(token, stranger.org.id)).rejects.toThrow(/not a member/);
  });
});
