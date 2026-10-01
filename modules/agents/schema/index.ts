import { sql, type SQL } from 'drizzle-orm';
import { boolean, customType, index, integer, jsonb, numeric, pgTable, real, text, uniqueIndex, uuid, vector, type AnyPgColumn } from 'drizzle-orm/pg-core';
import { tenantColumns, ts } from '@labelconsole/core/db/columns';
import type { LlmMessage } from '@labelconsole/core/llm';
import type { RiskLevel } from '@labelconsole/core/tools';

const tsvector = customType<{ data: string }>({ dataType: () => 'tsvector' });

export type ApprovalDecision = 'auto' | 'approve' | 'deny';
export type ApprovalPolicy = {
  /** Default decision per risk level. */
  risk: Record<RiskLevel, ApprovalDecision>;
  /** Per-tool overrides, e.g. { network_log_interaction: 'auto' }. */
  tools?: Record<string, ApprovalDecision>;
};
export type AgentBudget = { perRunUsd: number; perDayUsd: number };

export const AGENT_STATUSES = ['active', 'paused', 'archived'] as const;

export const agents = pgTable(
  'agents',
  {
    ...tenantColumns(),
    type: text('type').notNull(),
    name: text('name').notNull(),
    goal: text('goal').notNull(),
    instructions: text('instructions').notNull().default(''),
    model: text('model').notNull(),
    effort: text('effort').notNull().default('high'),
    toolAllowlist: text('tool_allowlist').array().notNull().default(sql`'{}'::text[]`),
    /** Built-in role the agent principal acts with; capped by the owner's own permissions. */
    role: text('role').notNull().default('viewer'),
    approvalPolicy: jsonb('approval_policy').$type<ApprovalPolicy>().notNull(),
    budget: jsonb('budget').$type<AgentBudget>().notNull(),
    maxSteps: integer('max_steps').notNull().default(25),
    maxRuntimeSec: integer('max_runtime_sec').notNull().default(1800),
    /** Allow the Claude web search server tool. */
    webResearch: boolean('web_research').notNull().default(false),
    status: text('status').notNull().default('active'),
    ownerUserId: uuid('owner_user_id').notNull(),
  },
  (t) => [index('agents_org_status_idx').on(t.orgId, t.status)],
);

export type TriggerConfig =
  | { kind: 'cron'; cron: string; timezone?: string }
  | { kind: 'event'; eventType: string; filter?: Record<string, string>; task?: string }
  | { kind: 'webhook'; tokenHash: string; task?: string }
  | { kind: 'manual' };

export const triggers = pgTable(
  'agent_triggers',
  {
    ...tenantColumns(),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),
    config: jsonb('config').$type<TriggerConfig>().notNull(),
    enabled: boolean('enabled').notNull().default(true),
    nextRunAt: ts('next_run_at'),
    lastFiredAt: ts('last_fired_at'),
    /** For webhook triggers: sha256 of the URL token, for lookup without the secret. */
    tokenHash: text('token_hash'),
  },
  (t) => [index('agent_triggers_due_idx').on(t.nextRunAt), uniqueIndex('agent_triggers_token_idx').on(t.tokenHash), index('agent_triggers_event_idx').on(t.orgId, t.kind)],
);

export const RUN_STATUSES = ['queued', 'running', 'waiting_approval', 'waiting_child', 'paused', 'completed', 'failed', 'stopped', 'budget_exceeded'] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];
export const TERMINAL_STATUSES: RunStatus[] = ['completed', 'failed', 'stopped', 'budget_exceeded'];

/** A tool call waiting for something (approval or a child run) before it can produce a result. */
export type PendingCall = { toolUseId: string; name: string; input: unknown; approvalId?: string; childRunId?: string; stepId?: string };

/** Durable run state: everything needed to resume from the last step after a crash. */
export type Checkpoint = {
  system: string;
  /** Tool names frozen at run start (same set and order every step). */
  tools: string[];
  messages: LlmMessage[];
  /** Results collected for the current assistant turn's tool calls, by tool_use id. */
  results: Record<string, { content: string; isError: boolean }>;
  pending: PendingCall[];
  compactions: number;
};

export const runs = pgTable(
  'agent_runs',
  {
    ...tenantColumns(),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    triggerId: uuid('trigger_id'),
    triggerKind: text('trigger_kind').notNull(),
    parentRunId: uuid('parent_run_id').references((): AnyPgColumn => runs.id, { onDelete: 'set null' }),
    /** Delegated task text, or a description of the trigger event. */
    task: text('task'),
    input: jsonb('input').$type<Record<string, unknown>>().notNull().default({}),
    status: text('status').$type<RunStatus>().notNull().default('queued'),
    /** What staff asked for; the runtime reconciles between steps. run | paused | stopped */
    desiredState: text('desired_state').notNull().default('run'),
    currentTask: text('current_task'),
    startedAt: ts('started_at'),
    endedAt: ts('ended_at'),
    tokensIn: integer('tokens_in').notNull().default(0),
    tokensOut: integer('tokens_out').notNull().default(0),
    costUsd: numeric('cost_usd', { precision: 12, scale: 6 }).notNull().default('0'),
    stepCount: integer('step_count').notNull().default(0),
    result: text('result'),
    error: text('error'),
    endReason: text('end_reason'),
    checkpoint: jsonb('checkpoint').$type<Checkpoint>(),
    /** Effective permissions frozen at run start (agent role ∩ owner ∩ parent). */
    permissions: text('permissions').array().notNull().default(sql`'{}'::text[]`),
    leaseOwner: text('lease_owner'),
    leaseExpiresAt: ts('lease_expires_at'),
    heartbeatAt: ts('heartbeat_at'),
    attempts: integer('attempts').notNull().default(0),
  },
  (t) => [
    index('agent_runs_agent_idx').on(t.orgId, t.agentId, t.createdAt),
    index('agent_runs_status_idx').on(t.status, t.leaseExpiresAt),
    index('agent_runs_parent_idx').on(t.parentRunId),
  ],
);

export const STEP_KINDS = ['plan', 'tool_call', 'tool_result', 'message', 'approval', 'delegation', 'compaction', 'error'] as const;
export type StepKind = (typeof STEP_KINDS)[number];

export const steps = pgTable(
  'agent_steps',
  {
    ...tenantColumns(),
    runId: uuid('run_id')
      .notNull()
      .references(() => runs.id, { onDelete: 'cascade' }),
    index: integer('index').notNull(),
    kind: text('kind').$type<StepKind>().notNull(),
    toolName: text('tool_name'),
    toolUseId: text('tool_use_id'),
    summary: text('summary'),
    input: jsonb('input'),
    output: jsonb('output'),
    tokensIn: integer('tokens_in').notNull().default(0),
    tokensOut: integer('tokens_out').notNull().default(0),
    costUsd: numeric('cost_usd', { precision: 12, scale: 6 }).notNull().default('0'),
    durationMs: integer('duration_ms').notNull().default(0),
    idempotencyKey: text('idempotency_key'),
    isError: boolean('is_error').notNull().default(false),
    model: text('model'),
  },
  (t) => [uniqueIndex('agent_steps_run_index_idx').on(t.runId, t.index), index('agent_steps_org_idx').on(t.orgId, t.createdAt)],
);

export const MEMORY_KINDS = ['fact', 'outcome', 'preference'] as const;

export const memories = pgTable(
  'agent_memories',
  {
    ...tenantColumns(),
    /** Null for org-wide memories shared by every agent. */
    agentId: uuid('agent_id').references(() => agents.id, { onDelete: 'cascade' }),
    scope: text('scope').notNull().default('agent'),
    kind: text('kind').notNull().default('fact'),
    content: text('content').notNull(),
    embedding: vector('embedding', { dimensions: 1024 }),
    tsv: tsvector('tsv').generatedAlwaysAs((): SQL => sql`to_tsvector('english', ${memories.content})`),
    importance: real('importance').notNull().default(0.5),
    sourceRunId: uuid('source_run_id'),
    expiresAt: ts('expires_at'),
    lastUsedAt: ts('last_used_at'),
  },
  (t) => [index('agent_memories_agent_idx').on(t.orgId, t.agentId), index('agent_memories_tsv_idx').using('gin', t.tsv)],
);

export const APPROVAL_STATUSES = ['pending', 'approved', 'rejected', 'expired'] as const;

export const approvals = pgTable(
  'approvals',
  {
    ...tenantColumns(),
    runId: uuid('run_id')
      .notNull()
      .references(() => runs.id, { onDelete: 'cascade' }),
    stepId: uuid('step_id'),
    agentId: uuid('agent_id').notNull(),
    toolName: text('tool_name').notNull(),
    toolUseId: text('tool_use_id').notNull(),
    risk: text('risk').notNull(),
    preview: text('preview').notNull(),
    payload: jsonb('payload').notNull(),
    editedPayload: jsonb('edited_payload'),
    status: text('status').notNull().default('pending'),
    decidedBy: uuid('decided_by'),
    decidedAt: ts('decided_at'),
    reason: text('reason'),
    expiresAt: ts('expires_at').notNull(),
  },
  (t) => [index('approvals_org_status_idx').on(t.orgId, t.status, t.createdAt), uniqueIndex('approvals_run_tool_use_idx').on(t.runId, t.toolUseId)],
);

export type Agent = typeof agents.$inferSelect;
export type Trigger = typeof triggers.$inferSelect;
export type Run = typeof runs.$inferSelect;
export type Step = typeof steps.$inferSelect;
export type Memory = typeof memories.$inferSelect;
export type Approval = typeof approvals.$inferSelect;
