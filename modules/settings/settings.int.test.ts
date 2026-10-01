import { and, eq } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import '../../test/modules';
import { withOrg, type ServiceContext } from '@labelconsole/core/context';
import { closeDb, systemDb } from '@labelconsole/core/db/client';
import { credentials, memberships } from '@labelconsole/core/db/schema';
import { ConflictError, ForbiddenError, ValidationError } from '@labelconsole/core/errors';
import { PermissionSet } from '@labelconsole/core/permissions';
import { closeQueues } from '@labelconsole/core/queue';
import { closeRedis } from '@labelconsole/core/redis';
import { addMember, makeOrg, type TestOrg } from '../../test/helpers';
import * as svc from './service';

afterAll(async () => {
  await closeQueues();
  await closeDb();
  await closeRedis();
});

const membershipOf = async (org: TestOrg, userId: string) => (await systemDb().select().from(memberships).where(and(eq(memberships.orgId, org.org.id), eq(memberships.userId, userId))))[0];

describe('settings', () => {
  it('always keeps an owner, and only owners change owners', async () => {
    const a = await makeOrg('Owner Label');
    const own = await membershipOf(a, a.user.id);
    await expect(a.as((ctx) => svc.changeRole(ctx, own.id, { role: 'admin' }))).rejects.toBeInstanceOf(ValidationError);
    await expect(a.as((ctx) => svc.removeMember(ctx, own.id))).rejects.toBeInstanceOf(ValidationError);
    const manager = await addMember(a, 'manager');
    await expect(manager.as((ctx) => svc.inviteMember(ctx, { email: 'x@example.test', role: 'viewer' }))).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('never lets someone hand out or take away more access than they have', async () => {
    const a = await makeOrg('Escalation Label');
    // A team lead who can manage members but nothing else sensitive.
    const lead = await a.as((ctx) => svc.createCustomRole(ctx, { name: 'Team lead', permissions: ['settings:read', 'settings:members', 'catalogue:read'] }));
    const leadUser = await addMember(a, 'viewer', 'Lead');
    const leadM = await membershipOf(a, leadUser.user.id);
    await a.as((ctx) => svc.changeRole(ctx, leadM.id, { role: 'custom', customRoleId: lead.id }));
    const asLead = <T>(fn: (ctx: ServiceContext) => Promise<T>) => withOrg({ orgId: a.org.id, actor: { type: 'user', id: leadUser.user.id, name: 'Lead' }, permissions: PermissionSet.forRole('custom', [], lead.permissions) }, fn);

    const viewer = await addMember(a, 'viewer');
    const viewerM = await membershipOf(a, viewer.user.id);
    // Can't promote anyone (including themselves) past their own access...
    await expect(asLead((ctx) => svc.changeRole(ctx, viewerM.id, { role: 'admin' }))).rejects.toBeInstanceOf(ForbiddenError);
    await expect(asLead((ctx) => svc.inviteMember(ctx, { email: 'new@example.test', role: 'manager' }))).rejects.toBeInstanceOf(ForbiddenError);
    await expect(asLead((ctx) => svc.createCustomRole(ctx, { name: 'Sneaky', permissions: ['settings:members', 'settings:credentials'] }))).rejects.toBeInstanceOf(ForbiddenError);
    // ...or demote someone with more access than they have.
    const admin = await addMember(a, 'admin');
    const adminM = await membershipOf(a, admin.user.id);
    await expect(asLead((ctx) => svc.changeRole(ctx, adminM.id, { role: 'viewer' }))).rejects.toBeInstanceOf(ForbiddenError);
    await expect(asLead((ctx) => svc.removeMember(ctx, adminM.id))).rejects.toBeInstanceOf(ForbiddenError);
    // Within their own access they still can act: moving someone between narrow roles they fully hold.
    const reader = await a.as((ctx) => svc.createCustomRole(ctx, { name: 'Catalogue reader', permissions: ['catalogue:read'] }));
    const settingsReader = await a.as((ctx) => svc.createCustomRole(ctx, { name: 'Settings reader', permissions: ['settings:read'] }));
    await a.as((ctx) => svc.changeRole(ctx, viewerM.id, { role: 'custom', customRoleId: reader.id }));
    await asLead((ctx) => svc.changeRole(ctx, viewerM.id, { role: 'custom', customRoleId: settingsReader.id }));
    expect((await membershipOf(a, viewer.user.id)).customRoleId).toBe(settingsReader.id);
    // The built-in viewer role reads every module, which is more than the lead holds.
    await expect(asLead((ctx) => svc.changeRole(ctx, viewerM.id, { role: 'viewer' }))).rejects.toBeInstanceOf(ForbiddenError);
    // Unknown permissions are refused outright.
    await expect(a.as((ctx) => svc.createCustomRole(ctx, { name: 'Typo', permissions: ['catalogue:wrte'] }))).rejects.toBeInstanceOf(ValidationError);
  });

  it('replaces a credential instead of stacking keys, and never returns the secret', async () => {
    const a = await makeOrg('Keys Label');
    await expect(a.as((ctx) => svc.saveCredential(ctx, { provider: 'youtube', apiKey: '' }))).rejects.toBeInstanceOf(ValidationError);
    await a.as((ctx) => svc.saveCredential(ctx, { provider: 'youtube', apiKey: 'AIza-first-key' }));
    await a.as((ctx) => svc.saveCredential(ctx, { provider: 'youtube', apiKey: 'AIza-second-key' }));
    const listed = await a.as(svc.credentialsStatus);
    expect(listed.filter((c) => c.provider === 'youtube')).toHaveLength(1);
    expect(JSON.stringify(listed)).not.toContain('AIza');
    const rows = await systemDb().select().from(credentials).where(eq(credentials.orgId, a.org.id));
    expect(rows.filter((r) => !r.revokedAt)).toHaveLength(1);
    expect(rows.every((r) => !r.ciphertext.includes('AIza'))).toBe(true);
  });

  it('guards label deletion and export, and keeps unsent workspace fields', async () => {
    const a = await makeOrg('Careful Label');
    await expect(a.as((ctx) => svc.requestDeletion(ctx, 'careful label'))).rejects.toBeInstanceOf(ValidationError);
    const manager = await addMember(a, 'manager');
    await expect(manager.as((ctx) => svc.requestDeletion(ctx, 'Careful Label'))).rejects.toBeInstanceOf(ForbiddenError);

    await a.as(svc.requestExport);
    await expect(a.as(svc.requestExport)).rejects.toBeInstanceOf(ConflictError);

    await a.as((ctx) => svc.updateWorkspace(ctx, { distributor: 'DistroKid', timezone: 'Europe/London' }));
    const after = await a.as((ctx) => svc.updateWorkspace(ctx, { legalEntity: 'Careful Label Ltd' }));
    expect(after.settings).toMatchObject({ distributor: 'DistroKid', timezone: 'Europe/London', legalEntity: 'Careful Label Ltd' });
  });
});
