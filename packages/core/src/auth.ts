import { createHash, randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { and, eq, gt, sql } from 'drizzle-orm';
import { systemDb } from './db/client';
import { customRoles, invitations, memberships, organizations, sessions, users } from './db/schema';
import { env } from './env';
import { ConflictError, UnauthorizedError, ValidationError } from './errors';
import { PermissionSet } from './permissions';

const scrypt = promisify(scryptCb) as (pw: string, salt: Buffer, len: number, opts: object) => Promise<Buffer>;
const SCRYPT = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

export const SESSION_COOKIE = 'lc_session';
export const SESSION_TTL_MS = 30 * 24 * 3600 * 1000;

export async function hashPassword(password: string): Promise<string> {
  if (password.length < 10) throw new ValidationError('Password must be at least 10 characters');
  const salt = randomBytes(16);
  const hash = await scrypt(password, salt, 64, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [algo, n, r, p, salt, hash] = stored.split('$');
  if (algo !== 'scrypt') return false;
  const expected = Buffer.from(hash, 'base64');
  const actual = await scrypt(password, Buffer.from(salt, 'base64'), expected.length, { N: Number(n), r: Number(r), p: Number(p), maxmem: SCRYPT.maxmem });
  return timingSafeEqual(expected, actual);
}

export const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');
export const newToken = () => randomBytes(32).toString('base64url');

export function slugify(name: string) {
  return (
    name
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'label'
  );
}

export function shortCodeFor(name: string) {
  const words = name.replace(/[^A-Za-z0-9 ]/g, ' ').split(/\s+/).filter(Boolean);
  const code = words.length >= 2 ? words.slice(0, 3).map((w) => w[0]).join('') : (words[0] ?? 'LBL').slice(0, 3);
  return code.toUpperCase();
}

async function uniqueSlug(base: string) {
  const db = systemDb();
  for (let i = 0; i < 50; i++) {
    const candidate = i === 0 ? base : `${base}-${i + 1}`;
    const [hit] = await db.select({ id: organizations.id }).from(organizations).where(eq(organizations.slug, candidate));
    if (!hit) return candidate;
  }
  return `${base}-${randomBytes(3).toString('hex')}`;
}

export type SessionInfo = {
  sessionId: string;
  user: { id: string; email: string; name: string };
  org: { id: string; name: string; slug: string; plan: string; settings: Record<string, unknown>; agentsPaused: boolean };
  membership: { id: string; role: string; artistScope: string[] | null };
  permissions: PermissionSet;
};

export async function createSession(userId: string, orgId: string | null, meta: { ip?: string; userAgent?: string } = {}) {
  const token = newToken();
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await systemDb().insert(sessions).values({ id: hashToken(token), userId, activeOrgId: orgId, expiresAt, ip: meta.ip, userAgent: meta.userAgent?.slice(0, 300) });
  return { token, expiresAt };
}

export async function revokeSession(token: string) {
  await systemDb().delete(sessions).where(eq(sessions.id, hashToken(token)));
}

/** Resolve a cookie token to user + active org + permissions. Null when invalid or expired. */
export async function validateSession(token: string | undefined | null): Promise<SessionInfo | null> {
  if (!token) return null;
  const db = systemDb();
  const id = hashToken(token);
  const [row] = await db
    .select({ s: sessions, u: users })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(and(eq(sessions.id, id), gt(sessions.expiresAt, new Date())));
  if (!row) return null;

  let orgId = row.s.activeOrgId;
  let m = orgId ? await membershipFor(row.u.id, orgId) : null;
  if (!m) {
    // Fall back to the first label the user belongs to.
    const [first] = await db
      .select({ orgId: memberships.orgId })
      .from(memberships)
      .where(and(eq(memberships.userId, row.u.id), eq(memberships.status, 'active')))
      .orderBy(memberships.createdAt)
      .limit(1);
    if (!first) return null;
    orgId = first.orgId;
    m = await membershipFor(row.u.id, orgId);
    if (!m) return null;
    await db.update(sessions).set({ activeOrgId: orgId }).where(eq(sessions.id, id));
  }

  // Sliding expiry, written at most every 10 minutes.
  if (Date.now() - row.s.lastSeenAt.getTime() > 10 * 60_000) {
    await db.update(sessions).set({ lastSeenAt: new Date(), expiresAt: new Date(Date.now() + SESSION_TTL_MS) }).where(eq(sessions.id, id));
    await db.update(users).set({ lastActiveAt: new Date() }).where(eq(users.id, row.u.id));
  }

  return {
    sessionId: id,
    user: { id: row.u.id, email: row.u.email, name: row.u.name },
    org: m.org,
    membership: { id: m.membership.id, role: m.membership.role, artistScope: m.membership.artistScope },
    permissions: m.permissions,
  };
}

async function membershipFor(userId: string, orgId: string) {
  const db = systemDb();
  const [row] = await db
    .select({ m: memberships, o: organizations })
    .from(memberships)
    .innerJoin(organizations, eq(organizations.id, memberships.orgId))
    .where(and(eq(memberships.userId, userId), eq(memberships.orgId, orgId), eq(memberships.status, 'active')));
  if (!row) return null;
  let customPerms: string[] | undefined;
  if (row.m.role === 'custom' && row.m.customRoleId) {
    const [cr] = await db.select().from(customRoles).where(eq(customRoles.id, row.m.customRoleId));
    customPerms = cr?.permissions;
  }
  return {
    membership: row.m,
    org: { id: row.o.id, name: row.o.name, slug: row.o.slug, plan: row.o.plan, settings: row.o.settings as Record<string, unknown>, agentsPaused: row.o.agentsPaused },
    permissions: PermissionSet.forRole(row.m.role, row.m.extraPermissions, customPerms),
  };
}

/** Effective permissions of a member right now (used to cap agents at their owner's rights). */
export async function memberPermissions(userId: string, orgId: string): Promise<PermissionSet | null> {
  return (await membershipFor(userId, orgId))?.permissions ?? null;
}

export async function listUserOrgs(userId: string) {
  return systemDb()
    .select({ id: organizations.id, name: organizations.name, slug: organizations.slug, role: memberships.role, settings: organizations.settings })
    .from(memberships)
    .innerJoin(organizations, eq(organizations.id, memberships.orgId))
    .where(and(eq(memberships.userId, userId), eq(memberships.status, 'active')))
    .orderBy(organizations.name);
}

export async function switchOrg(token: string, orgId: string) {
  const id = hashToken(token);
  const [s] = await systemDb().select().from(sessions).where(eq(sessions.id, id));
  if (!s) throw new UnauthorizedError();
  if (!(await membershipFor(s.userId, orgId))) throw new UnauthorizedError('You are not a member of that label');
  await systemDb().update(sessions).set({ activeOrgId: orgId }).where(eq(sessions.id, id));
}

export async function login(email: string, password: string) {
  const [u] = await systemDb().select().from(users).where(sql`lower(${users.email}) = ${email.trim().toLowerCase()}`);
  // Always run a hash comparison so timing does not reveal which emails exist.
  const ok = u ? await verifyPassword(password, u.passwordHash) : (await verifyPassword(password, DUMMY_HASH), false);
  if (!u || !ok) throw new UnauthorizedError('Email or password is incorrect');
  return u;
}

const DUMMY_HASH = 'scrypt$32768$8$1$AAAAAAAAAAAAAAAAAAAAAA==$' + Buffer.alloc(64).toString('base64');

export type SignupInput = { name: string; email: string; password: string; labelName: string };

/** Create a user, their first label and an owner membership. */
export async function signup(input: SignupInput) {
  const db = systemDb();
  const email = input.email.trim().toLowerCase();
  const [exists] = await db.select({ id: users.id }).from(users).where(sql`lower(${users.email}) = ${email}`);
  if (exists) throw new ConflictError('An account with that email already exists');
  const passwordHash = await hashPassword(input.password);
  const slug = await uniqueSlug(slugify(input.labelName));
  return db.transaction(async (tx) => {
    const [user] = await tx.insert(users).values({ email, name: input.name.trim(), passwordHash }).returning();
    const org = await createOrgTx(tx, { name: input.labelName.trim(), slug, ownerUserId: user.id });
    return { user, org };
  });
}

/** True until the installation's label exists. Only then is the first-run setup open. */
export async function setupNeeded(): Promise<boolean> {
  const [org] = await systemDb().select({ id: organizations.id }).from(organizations).limit(1);
  return !org;
}

/**
 * First-run setup: create the installation's one label (LABEL_NAME) and its
 * owner. There is no public sign-up; once any label exists this refuses, and
 * further people join by invitation. A transaction-level lock makes two
 * simultaneous attempts safe: the second one sees the label and is refused.
 */
export async function setupLabel(input: { name: string; email: string; password: string }) {
  const email = input.email.trim().toLowerCase();
  const passwordHash = await hashPassword(input.password);
  const labelName = env().LABEL_NAME;
  const slug = await uniqueSlug(slugify(labelName));
  return systemDb().transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('labelconsole:setup'))`);
    const [org] = await tx.select({ id: organizations.id }).from(organizations).limit(1);
    if (org) throw new ConflictError(`${labelName} is already set up. Sign in, or ask the owner for an invitation.`);
    const [exists] = await tx.select({ id: users.id }).from(users).where(sql`lower(${users.email}) = ${email}`);
    if (exists) throw new ConflictError('An account with that email already exists');
    const [user] = await tx.insert(users).values({ email, name: input.name.trim(), passwordHash }).returning();
    return { user, org: await createOrgTx(tx, { name: labelName, slug, ownerUserId: user.id }) };
  });
}

/**
 * For the `pnpm owner` command: make sure the installation's label exists and
 * that this person is its owner with this password. Creates what is missing,
 * so it also recovers a forgotten password (there is no email reset).
 */
export async function ensureOwner(input: { name?: string; email: string; password: string }) {
  const email = input.email.trim().toLowerCase();
  const passwordHash = await hashPassword(input.password);
  const labelName = env().LABEL_NAME;
  const slug = await uniqueSlug(slugify(labelName));
  return systemDb().transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('labelconsole:setup'))`);
    const [existing] = await tx.select().from(users).where(sql`lower(${users.email}) = ${email}`);
    const user = existing
      ? (await tx.update(users).set({ passwordHash, ...(input.name?.trim() ? { name: input.name.trim() } : {}) }).where(eq(users.id, existing.id)).returning())[0]
      : (await tx.insert(users).values({ email, name: input.name?.trim() || email.split('@')[0], passwordHash }).returning())[0];
    const [found] = await tx.select().from(organizations).where(eq(organizations.name, labelName)).limit(1);
    const org = found ?? (await createOrgTx(tx, { name: labelName, slug, ownerUserId: user.id }));
    await tx
      .insert(memberships)
      .values({ orgId: org.id, userId: user.id, role: 'owner', createdBy: 'system:owner-command' })
      .onConflictDoUpdate({ target: [memberships.orgId, memberships.userId], set: { role: 'owner', status: 'active' } });
    // Signing in with a new password ends every older session.
    if (existing) await tx.delete(sessions).where(eq(sessions.userId, user.id));
    return { user, org, createdUser: !existing, createdLabel: !found };
  });
}

type SystemTx = Parameters<Parameters<ReturnType<typeof systemDb>['transaction']>[0]>[0];

async function createOrgTx(tx: SystemTx, input: { name: string; slug: string; ownerUserId: string; plan?: string }) {
  const [org] = await tx
    .insert(organizations)
    .values({
      name: input.name,
      slug: input.slug,
      plan: input.plan ?? 'growth',
      createdBy: `user:${input.ownerUserId}`,
      settings: { shortCode: shortCodeFor(input.name), currency: 'USD', timezone: 'UTC', streamPollHoursActive: 6, streamPollHoursCatalogue: 24, auditRetentionMonths: 24 },
    })
    .returning();
  await tx.insert(memberships).values({ orgId: org.id, userId: input.ownerUserId, role: 'owner', createdBy: `user:${input.ownerUserId}` });
  return org;
}

/** An existing user creates an additional label (tests and multi-label installs; this installation runs one label). */
export async function createOrgForUser(userId: string, name: string) {
  const slug = await uniqueSlug(slugify(name));
  return systemDb().transaction((tx) => createOrgTx(tx, { name: name.trim(), slug, ownerUserId: userId }));
}

/** Accept an invitation: creates the account if needed and the membership. */
export async function acceptInvitation(token: string, input: { name?: string; password?: string; existingUserId?: string }) {
  const db = systemDb();
  const [inv] = await db.select().from(invitations).where(eq(invitations.tokenHash, hashToken(token)));
  if (!inv || inv.acceptedAt || inv.revokedAt || inv.expiresAt < new Date()) throw new ValidationError('This invitation is no longer valid');
  return db.transaction(async (tx) => {
    let userId = input.existingUserId;
    if (!userId) {
      const [existing] = await tx.select().from(users).where(sql`lower(${users.email}) = ${inv.email.toLowerCase()}`);
      if (existing) {
        if (!input.password || !(await verifyPassword(input.password, existing.passwordHash))) throw new UnauthorizedError('Sign in to accept this invitation');
        userId = existing.id;
      } else {
        if (!input.name || !input.password) throw new ValidationError('Name and password are required');
        const [u] = await tx.insert(users).values({ email: inv.email.toLowerCase(), name: input.name, passwordHash: await hashPassword(input.password) }).returning();
        userId = u.id;
      }
    }
    await tx
      .insert(memberships)
      .values({ orgId: inv.orgId, userId, role: inv.role, createdBy: inv.createdBy })
      .onConflictDoUpdate({ target: [memberships.orgId, memberships.userId], set: { role: inv.role, status: 'active' } });
    await tx.update(invitations).set({ acceptedAt: new Date() }).where(eq(invitations.id, inv.id));
    return { userId, orgId: inv.orgId };
  });
}

export async function peekInvitation(token: string) {
  const [row] = await systemDb()
    .select({ email: invitations.email, role: invitations.role, orgName: organizations.name, expiresAt: invitations.expiresAt, acceptedAt: invitations.acceptedAt, revokedAt: invitations.revokedAt })
    .from(invitations)
    .innerJoin(organizations, eq(organizations.id, invitations.orgId))
    .where(eq(invitations.tokenHash, hashToken(token)));
  if (!row || row.acceptedAt || row.revokedAt || row.expiresAt < new Date()) return null;
  return row;
}
