import { signup } from '@labelconsole/core/auth';
import { withOrg, withSystemOrg, type ServiceContext } from '@labelconsole/core/context';
import { logger } from '@labelconsole/core/logger';
import type { JobContext, JobDefinition } from '@labelconsole/core/queue';
import { PermissionSet, type BuiltInRole } from '@labelconsole/core/permissions';
import { systemDb } from '@labelconsole/core/db/client';
import { memberships } from '@labelconsole/core/db/schema';

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

/** Another person in an existing label, with a built-in role, and a helper to act as them. */
export async function addMember(org: TestOrg, role: BuiltInRole, name = `${role} member`) {
  const { user } = await signup({ name, email: uniqueEmail(), password: 'correct horse battery', labelName: `${name}'s own label` });
  await systemDb().insert(memberships).values({ orgId: org.org.id, userId: user.id, role, createdBy: `user:${org.user.id}` });
  const as = <T>(fn: (ctx: ServiceContext) => Promise<T>) => withOrg({ orgId: org.org.id, actor: { type: 'user', id: user.id, name: user.name }, permissions: PermissionSet.forRole(role) }, fn);
  return { user, as };
}

/** Run a job handler in-process, the way the worker would, without a queue. */
export function jobContext(orgId: string | null, name = 'test-job', opts: { attempts?: number; attemptsMade?: number } = {}) {
  const ctx: JobContext = {
    orgId,
    job: { id: `test-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, name, attemptsMade: opts.attemptsMade ?? 0, opts: { attempts: opts.attempts ?? 1 } } as unknown as JobContext['job'],
    log: logger.child({ test: name }),
    progress: async () => {},
    withOrg: (fn) => {
      if (!orgId) throw new Error('job has no org');
      return withSystemOrg(orgId, fn, `job:${name}`);
    },
  };
  return ctx;
}

/** Find a module job definition by name and run it with the given data. */
export async function runJob(jobs: JobDefinition[], name: string, orgId: string | null, data: unknown = {}, opts: { attempts?: number; attemptsMade?: number } = {}) {
  const def = jobs.find((j) => j.name === name);
  if (!def) throw new Error(`No job ${name}`);
  return def.handler(jobContext(orgId, name, opts), data);
}
