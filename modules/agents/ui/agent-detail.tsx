import Link from 'next/link';
import type { PageProps } from '@labelconsole/core/web';
import { env } from '@labelconsole/core/env';
import { MODELS } from '@labelconsole/core/llm-models';
import { BUILT_IN_ROLES, ROLE_LABELS } from '@labelconsole/core/permissions';
import { Card, DataTable, Icon, KV, Page, PageHeader, StatCard, Tag, fmt } from '@labelconsole/ui';
import { ActionButton, ApiToggle, FormModal } from '@labelconsole/ui/client';
import { agentType } from '../agent-types';
import type { TriggerConfig } from '../schema';
import * as svc from '../service';
import { AgentBuilder } from './builder';
import { LiveRefresh } from './live';
import { CRON_PRESETS, describeCron, RunChip, TRIGGER_EVENTS, TRIGGER_LABEL, usd } from './shared';
import { AddWebhook } from './webhook';

export default async function AgentDetailPage({ run, params, session }: PageProps) {
  const can = (p: string) => session.permissions.has(p);
  const [agent, triggerRows, runRows, tools, mems, spentToday] = await run((ctx) =>
    Promise.all([svc.getAgentRow(ctx, params.id), svc.triggersFor(ctx, params.id), svc.recentRunsFor(ctx, params.id), svc.availableTools(ctx), svc.listMemories(ctx, { agentId: params.id }), svc.agentSpendToday(ctx, params.id)]),
  );
  const type = agentType(agent.type);
  const describe = (c: TriggerConfig) => (c.kind === 'cron' ? `${describeCron(c.cron)} (${c.timezone ?? 'UTC'})` : c.kind === 'event' ? `On ${c.eventType}` : c.kind === 'webhook' ? 'Inbound webhook' : 'Manual');

  return (
    <Page>
      <LiveRefresh />
      <PageHeader
        title={
          <span className="lc-row" style={{ gap: 12 }}>
            {agent.name}
            <Tag>{type?.name ?? agent.type}</Tag>
          </span>
        }
        description={agent.goal}
        actions={
          <>
            {can('agents:run') && agent.status === 'active' && (
              <FormModal title={`Run ${agent.name}`} trigger={{ label: 'Run now', icon: 'play_arrow', variant: 'primary' }} endpoint={`/agents/${agent.id}/run`} fields={[{ name: 'task', label: 'Task (optional)', type: 'textarea', placeholder: 'Leave empty to work toward its goal' }]} columns={1} redirectTo="/agents/runs/{id}" success="Run started" />
            )}
            {can('agents:manage') && <ActionButton endpoint={`/agents/${agent.id}`} method="DELETE" label={runRows.length ? 'Archive' : 'Delete'} icon="archive" variant="ghost" confirm={`${runRows.length ? 'Archive' : 'Delete'} ${agent.name}? ${runRows.length ? 'Its history stays for audit.' : ''}`} redirectTo="/agents" />}
          </>
        }
      />
      <div className="lc-grid-stats">
        <StatCard label="STATUS" icon="radio_button_checked" value={fmt.titleCase(agent.status)} note={`owner ${agent.ownerUserId === session.user.id ? 'you' : 'another member'}`} />
        <StatCard label="SPENT TODAY" icon="payments" value={usd(spentToday)} note={`of ${usd(agent.budget.perDayUsd)} a day · ${usd(agent.budget.perRunUsd)} per run`} />
        <StatCard label="RUNS" icon="history" value={String(runRows.length)} note={runRows[0] ? `last ${fmt.relative(runRows[0].createdAt)}` : 'never run'} />
        <StatCard label="MEMORIES" icon="neurology" value={String(mems.length)} note="facts, outcomes, preferences" href={`/agents/memory?agent=${agent.id}`} />
      </div>

      <div className="lc-grid-2">
        <Card
          title="Triggers"
          sub="What starts this agent besides a person pressing Run."
          actions={
            can('agents:manage') && (
              <span className="lc-row" style={{ gap: 6 }}>
                <FormModal title="Schedule" trigger={{ label: 'Schedule', icon: 'schedule', size: 'sm' }} endpoint={`/agents/${agent.id}/triggers`} extra={{ kind: 'cron' }} fields={[{ name: 'cron', label: 'When', type: 'select', required: true, options: CRON_PRESETS }, { name: 'timezone', label: 'Timezone', placeholder: 'Label timezone' }]} initial={{ cron: '0 9 * * *' }} columns={1} success="Schedule added" />
                <FormModal title="Event trigger" trigger={{ label: 'Event', icon: 'bolt', size: 'sm' }} endpoint={`/agents/${agent.id}/triggers`} extra={{ kind: 'event' }} fields={[{ name: 'eventType', label: 'When this happens', type: 'select', required: true, options: TRIGGER_EVENTS.map((e) => ({ value: e, label: e })) }, { name: 'task', label: 'Task for the agent', type: 'textarea' }]} columns={1} success="Event trigger added" />
                <AddWebhook agentId={agent.id} appUrl={env().APP_URL} />
              </span>
            )
          }
        >
          {triggerRows.length === 0 && <span className="lc-muted" style={{ fontSize: 13 }}>Only runs when started by hand.</span>}
          {triggerRows.map((t) => (
            <div key={t.id} className="lc-kv">
              <span className="lc-cell-stack">
                <span>{describe(t.config)}</span>
                <span className="lc-cell-sub">{TRIGGER_LABEL[t.kind]}{t.nextRunAt && t.enabled ? ` · next ${fmt.shortDate(t.nextRunAt)} ${fmt.time(t.nextRunAt)}` : ''}{t.lastFiredAt ? ` · last ${fmt.relative(t.lastFiredAt)}` : ''}</span>
              </span>
              <span className="lc-row" style={{ gap: 6, flexWrap: 'nowrap' }}>
                <ApiToggle endpoint={`/agent-triggers/${t.id}`} field="enabled" on={t.enabled} disabled={!can('agents:manage')} title="Enabled" />
                {can('agents:manage') && <ActionButton iconOnly icon="delete" title="Remove trigger" variant="danger" endpoint={`/agent-triggers/${t.id}`} method="DELETE" confirm="Remove this trigger?" />}
              </span>
            </div>
          ))}
        </Card>
        <Card title="What it is for" sub={type?.description}>
          <KV k="Needs approval for" v={<span style={{ fontSize: 13 }}>{(['write', 'external', 'destructive', 'spend'] as const).filter((r) => agent.approvalPolicy.risk[r] === 'approve').join(', ') || 'nothing'}</span>} />
          <KV k="Never allowed" v={<span style={{ fontSize: 13 }}>{(['write', 'external', 'destructive', 'spend'] as const).filter((r) => agent.approvalPolicy.risk[r] === 'deny').join(', ') || '—'}</span>} />
          <KV k="Final answer covers" v={<span style={{ fontSize: 13, textAlign: 'right' }}>{type?.output ?? '—'}</span>} />
        </Card>
      </div>

      <DataTable
        title="Recent runs"
        rows={runRows}
        rowKey={(r) => r.id}
        rowHref={(r) => `/agents/runs/${r.id}`}
        minWidth={820}
        empty="No runs yet."
        columns={[
          { key: 's', header: 'Status', width: '140px', render: (r) => <RunChip status={r.status} /> },
          { key: 't', header: 'Task', width: 'minmax(220px,1.5fr)', render: (r) => <span className="lc-cell-stack"><span className="lc-ellipsis">{r.task ?? 'Scheduled work'}</span><span className="lc-cell-sub lc-ellipsis">{r.result ?? r.error ?? r.currentTask ?? ''}</span></span> },
          { key: 'k', header: 'Trigger', width: '100px', render: (r) => <span style={{ fontSize: 13 }}>{TRIGGER_LABEL[r.triggerKind] ?? r.triggerKind}</span> },
          { key: 'n', header: 'Steps', width: '70px', align: 'right', render: (r) => <span className="lc-cell-num">{r.stepCount}</span> },
          { key: 'c', header: 'Cost', width: '80px', align: 'right', render: (r) => <span className="lc-cell-num">{usd(r.costUsd)}</span> },
          { key: 'd', header: 'Started', width: '110px', render: (r) => <span className="lc-mono" style={{ fontSize: 12, color: 'var(--lc-muted)' }}>{fmt.relative(r.createdAt)}</span> },
        ]}
      />

      <Card title="Configuration" sub="Changes apply to new runs; a run keeps the prompt and tools it started with.">
        <AgentBuilder
          agentId={agent.id}
          disabled={!can('agents:manage')}
          initial={{ name: agent.name, goal: agent.goal, instructions: agent.instructions, model: agent.model, effort: agent.effort, role: agent.role, toolAllowlist: agent.toolAllowlist, approvalPolicy: agent.approvalPolicy, budget: agent.budget, maxSteps: agent.maxSteps, maxRuntimeSec: agent.maxRuntimeSec, webResearch: agent.webResearch, status: agent.status === 'archived' ? 'paused' : agent.status }}
          models={MODELS.map((m) => ({ value: m.id, label: `${m.label} · $${m.input}/$${m.output} per M tokens` }))}
          roles={BUILT_IN_ROLES.filter((r) => r !== 'owner').map((r) => ({ value: r, label: ROLE_LABELS[r] ?? r }))}
          tools={tools.map((t) => ({ name: t.name, module: t.module, description: t.description, risk: t.risk, requiresApproval: Boolean(t.requiresApproval) }))}
        />
      </Card>
      <Link href="/agents" className="lc-btn lc-btn--link"><Icon name="arrow_back" />All agents</Link>
    </Page>
  );
}
