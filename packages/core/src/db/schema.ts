import { sql } from 'drizzle-orm';
import {
  bigserial,
  boolean,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { orgIdColumn, tenantColumns, ts } from './columns';

/* ------------------------------------------------------------------------- */
/* Identity (not tenant scoped: a user can belong to several labels)          */
/* ------------------------------------------------------------------------- */

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    email: text('email').notNull(),
    name: text('name').notNull(),
    passwordHash: text('password_hash').notNull(),
    emailVerifiedAt: ts('email_verified_at'),
    lastActiveAt: ts('last_active_at'),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at')
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [uniqueIndex('users_email_lower_idx').on(sql`lower(${t.email})`)],
);

export const sessions = pgTable(
  'sessions',
  {
    /** sha256 of the opaque token in the cookie; the raw token is never stored. */
    id: text('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    activeOrgId: uuid('active_org_id'),
    expiresAt: ts('expires_at').notNull(),
    ip: text('ip'),
    userAgent: text('user_agent'),
    createdAt: ts('created_at').notNull().defaultNow(),
    lastSeenAt: ts('last_seen_at').notNull().defaultNow(),
  },
  (t) => [index('sessions_user_idx').on(t.userId)],
);

/* ------------------------------------------------------------------------- */
/* Tenancy                                                                    */
/* ------------------------------------------------------------------------- */

export type OrgSettings = {
  shortCode?: string;
  legalEntity?: string;
  distributor?: string;
  currency?: string;
  siteUrl?: string;
  timezone?: string;
  /** Hours between stream polls for tracks in an active campaign / back catalogue. */
  streamPollHoursActive?: number;
  streamPollHoursCatalogue?: number;
  /** Monthly agent spend cap in USD; null means no cap beyond the plan default. */
  agentMonthlyBudgetUsd?: number | null;
  /** Months of audit log retained. */
  auditRetentionMonths?: number;
};

export const organizations = pgTable('organizations', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  slug: text('slug').notNull().unique(),
  plan: text('plan').notNull().default('growth'),
  settings: jsonb('settings').$type<OrgSettings>().notNull().default({}),
  /** Kill switch: when true no agent may start or continue a step in this org. */
  agentsPaused: boolean('agents_paused').notNull().default(false),
  createdAt: ts('created_at').notNull().defaultNow(),
  updatedAt: ts('updated_at')
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
  createdBy: text('created_by'),
});

export const memberships = pgTable(
  'memberships',
  {
    ...tenantColumns(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** Built-in role key (owner, admin, manager, ar, marketing, finance, viewer) or `custom`. */
    role: text('role').notNull().default('viewer'),
    customRoleId: uuid('custom_role_id'),
    /** Extra grants on top of the role. */
    extraPermissions: text('extra_permissions').array().notNull().default(sql`'{}'::text[]`),
    /** When set, the member only sees these artists' data in artist-scoped modules. */
    artistScope: uuid('artist_scope').array(),
    status: text('status').notNull().default('active'),
  },
  (t) => [uniqueIndex('memberships_org_user_idx').on(t.orgId, t.userId), index('memberships_user_idx').on(t.userId)],
);

export const customRoles = pgTable(
  'custom_roles',
  {
    ...tenantColumns(),
    name: text('name').notNull(),
    description: text('description'),
    permissions: text('permissions').array().notNull().default(sql`'{}'::text[]`),
  },
  (t) => [uniqueIndex('custom_roles_org_name_idx').on(t.orgId, t.name)],
);

export const invitations = pgTable(
  'invitations',
  {
    ...tenantColumns(),
    email: text('email').notNull(),
    role: text('role').notNull(),
    tokenHash: text('token_hash').notNull().unique(),
    expiresAt: ts('expires_at').notNull(),
    acceptedAt: ts('accepted_at'),
    revokedAt: ts('revoked_at'),
  },
  (t) => [index('invitations_org_idx').on(t.orgId)],
);

/** Which modules an org has switched on. Missing row = plan default. */
export const orgModules = pgTable(
  'org_modules',
  {
    orgId: orgIdColumn(),
    module: text('module').notNull(),
    enabled: boolean('enabled').notNull(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.orgId, t.module] })],
);

/* ------------------------------------------------------------------------- */
/* Credentials vault (envelope encryption)                                    */
/* ------------------------------------------------------------------------- */

export const orgKeys = pgTable('org_keys', {
  orgId: uuid('org_id')
    .primaryKey()
    .default(sql`nullif(current_setting('app.org_id', true), '')::uuid`),
  /** Per-org data key, wrapped (encrypted) by the master key. */
  wrappedKey: text('wrapped_key').notNull(),
  masterKeyId: text('master_key_id').notNull(),
  createdAt: ts('created_at').notNull().defaultNow(),
});

export const credentials = pgTable(
  'credentials',
  {
    ...tenantColumns(),
    provider: text('provider').notNull(),
    label: text('label').notNull(),
    scope: text('scope').array().notNull().default(sql`'{}'::text[]`),
    ciphertext: text('ciphertext').notNull(),
    iv: text('iv').notNull(),
    authTag: text('auth_tag').notNull(),
    /** Non-secret display data, e.g. the account name an OAuth token belongs to. */
    metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
    lastUsedAt: ts('last_used_at'),
    revokedAt: ts('revoked_at'),
  },
  (t) => [index('credentials_org_provider_idx').on(t.orgId, t.provider)],
);

/* ------------------------------------------------------------------------- */
/* Audit log                                                                  */
/* ------------------------------------------------------------------------- */

export const auditLog = pgTable(
  'audit_log',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: orgIdColumn(),
    actorType: text('actor_type').notNull(),
    actorId: text('actor_id'),
    actorLabel: text('actor_label'),
    action: text('action').notNull(),
    module: text('module').notNull(),
    targetType: text('target_type'),
    targetId: text('target_id'),
    targetLabel: text('target_label'),
    before: jsonb('before'),
    after: jsonb('after'),
    agentRunId: uuid('agent_run_id'),
    agentStepId: uuid('agent_step_id'),
    ip: text('ip'),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [index('audit_org_created_idx').on(t.orgId, t.createdAt), index('audit_target_idx').on(t.orgId, t.targetType, t.targetId)],
);

/* ------------------------------------------------------------------------- */
/* Domain events (transactional outbox)                                       */
/* ------------------------------------------------------------------------- */

export const domainEvents = pgTable(
  'domain_events',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    orgId: orgIdColumn(),
    type: text('type').notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    actor: text('actor'),
    createdAt: ts('created_at').notNull().defaultNow(),
    dispatchedAt: ts('dispatched_at'),
    attempts: integer('attempts').notNull().default(0),
  },
  (t) => [index('domain_events_pending_idx').on(t.id).where(sql`${t.dispatchedAt} is null`), index('domain_events_org_type_idx').on(t.orgId, t.type)],
);

/** Results of idempotent side effects (tool calls, outbound sends) keyed by caller-supplied key. */
export const idempotencyKeys = pgTable(
  'idempotency_keys',
  {
    orgId: orgIdColumn(),
    key: text('key').notNull(),
    status: text('status').notNull().default('in_progress'),
    result: jsonb('result'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    completedAt: ts('completed_at'),
  },
  (t) => [primaryKey({ columns: [t.orgId, t.key] })],
);

/** Org-wide usage counters (agent spend, API calls) aggregated per month for billing. */
export const usageCounters = pgTable(
  'usage_counters',
  {
    orgId: orgIdColumn(),
    month: text('month').notNull(),
    metric: text('metric').notNull(),
    value: numeric('value', { precision: 18, scale: 6 }).notNull().default('0'),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.orgId, t.month, t.metric] })],
);
