import { signup } from '@labelconsole/core/auth';
import { withOrg, withSystemOrg, type ServiceContext } from '@labelconsole/core/context';
import { logger } from '@labelconsole/core/logger';
import type { JobContext, JobDefinition } from '@labelconsole/core/queue';
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

/** Run a job handler in-process, the way the worker would, without a queue. */
export function jobContext(orgId: string | null, name = 'test-job') {
  const ctx: JobContext = {
    orgId,
    job: { id: `test-${Date.now()}`, name, attemptsMade: 0 } as unknown as JobContext['job'],
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
export async function runJob(jobs: JobDefinition[], name: string, orgId: string | null, data: unknown = {}) {
  const def = jobs.find((j) => j.name === name);
  if (!def) throw new Error(`No job ${name}`);
  return def.handler(jobContext(orgId, name), data);
}
