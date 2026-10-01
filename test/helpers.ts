import { signup } from '@labelconsole/core/auth';
import { withOrg, type ServiceContext } from '@labelconsole/core/context';
import { PermissionSet } from '@labelconsole/core/permissions';

let n = 0;
export const uniqueEmail = () => `user${Date.now().toString(36)}${n++}@example.test`;

export type TestOrg = Awaited<ReturnType<typeof makeOrg>>;

/** A fresh label with an owner, plus a helper to run code as that owner. */
export async function makeOrg(label = 'Test Label') {
  const { user, org } = await signup({ name: 'Test Owner', email: uniqueEmail(), password: 'correct horse battery', labelName: label });
  const as = <T>(fn: (ctx: ServiceContext) => Promise<T>, permissions?: PermissionSet) =>
    withOrg({ orgId: org.id, actor: { type: 'user', id: user.id, name: user.name }, permissions: permissions ?? PermissionSet.forRole('owner') }, fn);
  return { user, org, as };
}
