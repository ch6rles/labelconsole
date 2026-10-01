import Link from 'next/link';
import type { PageProps } from '@labelconsole/core/web';
import { Banner, Card, Icon, KV, Page, PageHeader, StatCard, fmt } from '@labelconsole/ui';
import { ActionButton } from '@labelconsole/ui/client';
import type { Step } from '../schema';
import * as svc from '../service';
import { ApprovalActions } from './approval-actions';
import { LiveRefresh } from './live';
import { RunChip, TRIGGER_LABEL, usd } from './shared';

const STEP_ICON: Record<string, string> = { plan: 'route', message: 'chat', tool_call: 'build', tool_result: 'output', approval: 'gavel', delegation: 'call_split', compaction: 'compress', error: 'error' };

function StepRow({ s }: { s: Step }) {
  const out = s.output as Record<string, unknown> | null;
  const text = typeof out?.text === 'string' ? out.text : null;
  const thinking = typeof out?.thinking === 'string' ? out.thinking : null;
  return (
    <div className="lc-kv" style={{ alignItems: 'flex-start', gap: 14 }}>
      <span className="lc-row" style={{ gap: 12, alignItems: 'flex-start', flex: 1, minWidth: 0 }}>
        <Icon name={STEP_ICON[s.kind] ?? 'circle'} size={18} style={{ color: s.isError ? 'var(--lc-danger)' : 'var(--lc-muted)', marginTop: 2 }} />
        <span className="lc-stack" style={{ gap: 4, minWidth: 0, flex: 1 }}>
          <span style={{ fontSize: 14, fontWeight: s.kind === 'plan' ? 600 : 400, color: s.isError ? 'var(--lc-danger)' : undefined, whiteSpace: 'pre-wrap' }}>
            {s.kind === 'message' || s.kind === 'plan' ? text || s.summary : s.summary}
          </span>
          {thinking && (
            <details>
              <summary className="lc-cell-sub">Reasoning summary</summary>
              <p className="lc-cell-sub" style={{ whiteSpace: 'pre-wrap', margin: '6px 0 0' }}>{thinking}</p>
            </details>
          )}
          {(s.kind === 'tool_call' || s.kind === 'delegation' || s.kind === 'approval') && (
            <details>
              <summary className="lc-cell-sub">{s.toolName} · input{s.output ? ' and result' : ''}</summary>
              <pre className="lc-mono" style={{ fontSize: 11, whiteSpace: 'pre-wrap', wordBreak: 'break-word', background: 'var(--lc-bg-sidebar)', padding: 10, margin: '6px 0 0', maxHeight: 360, overflow: 'auto' }}>
                {JSON.stringify(s.input, null, 2)}
                {s.output ? `\n\n→ ${JSON.stringify(s.output, null, 2)}` : ''}
              </pre>
            </details>
          )}
        </span>
      </span>
      <span className="lc-mono" style={{ fontSize: 11, color: 'var(--lc-muted)', whiteSpace: 'nowrap', textAlign: 'right' }}>
        #{s.index} · {fmt.time(s.createdAt)}
        {Number(s.costUsd) > 0 ? <><br />{usd(s.costUsd)}</> : null}
        {s.durationMs ? <><br />{(s.durationMs / 1000).toFixed(1)}s</> : null}
      </span>
    </div>
  );
}

export default async function RunDetailPage({ run, params, session }: PageProps) {
  const d = await run((ctx) => svc.getRun(ctx, params.id));
  const r = d.run;
  const can = (p: string) => session.permissions.has(p);
  const active = ['queued', 'running', 'waiting_approval', 'waiting_child', 'paused'].includes(r.status);
  const pending = d.approvals.filter((a) => a.status === 'pending');

  return (
    <Page>
      <LiveRefresh runId={r.id} />
      <PageHeader
        title={
          <span className="lc-row" style={{ gap: 12 }}>
            {d.agent?.name ?? 'Agent'} run
            <RunChip status={r.status} />
          </span>
        }
        description={r.task ?? 'Scheduled work toward its goal'}
        actions={
          can('agents:run') &&
          active && (
            <>
              {r.status === 'paused' || r.desiredState === 'paused' ? (
                <ActionButton endpoint={`/agent-runs/${r.id}/control`} body={{ action: 'resume' }} label="Resume" icon="play_arrow" success="Resuming" />
              ) : (
                <ActionButton endpoint={`/agent-runs/${r.id}/control`} body={{ action: 'pause' }} label="Pause" icon="pause" success="Pausing after the current step" />
              )}
              <ActionButton endpoint={`/agent-runs/${r.id}/control`} body={{ action: 'stop' }} label="Stop" icon="stop" variant="danger" confirm="Stop this run now? In-flight work is interrupted." success="Stopping" />
            </>
          )
        }
      />
      {r.status === 'completed' && r.result && <Banner icon="task_alt">{r.result}</Banner>}
      {r.error && <Banner icon="error" warn>{r.error}</Banner>}
      <div className="lc-grid-stats">
        <StatCard label="NOW" icon="pending" value={<span style={{ fontSize: 20, lineHeight: 1.3, display: 'block' }}>{r.currentTask ?? '—'}</span>} note={r.desiredState !== 'run' && active ? `${r.desiredState} requested` : `${TRIGGER_LABEL[r.triggerKind] ?? r.triggerKind} run`} />
        <StatCard label="STEPS" icon="format_list_numbered" value={`${r.stepCount}${d.agent ? ` / ${d.agent.maxSteps}` : ''}`} note={r.startedAt ? `started ${fmt.relative(r.startedAt)}` : 'not started yet'} />
        <StatCard label="COST" icon="payments" value={usd(r.costUsd)} note={d.agent ? `budget ${usd(d.agent.budget.perRunUsd)} per run` : ''} />
        <StatCard label="TOKENS" icon="token" value={fmt.compact(r.tokensIn + r.tokensOut)} note={`${fmt.compact(r.tokensIn)} in · ${fmt.compact(r.tokensOut)} out`} />
      </div>

      {pending.length > 0 && (
        <Card title="Waiting for your approval" sub="The run is paused until someone decides.">
          {pending.map((a) => (
            <div key={a.id} className="lc-kv" style={{ alignItems: 'flex-start' }}>
              <span className="lc-cell-stack">
                <span style={{ fontSize: 14 }}>{a.preview}</span>
                <span className="lc-cell-sub">{a.toolName} · {a.risk} · expires {fmt.relative(a.expiresAt)}</span>
              </span>
              {can('agents:approve') ? <ApprovalActions id={a.id} payload={a.payload} compact /> : <span className="lc-muted">Needs someone with approval rights</span>}
            </div>
          ))}
        </Card>
      )}

      {(d.parent || d.children.length > 0) && (
        <Card title="Plan" sub="Who delegated what. Delegated runs can only do what both agents may do, and spend from the same budget.">
          {d.parent && <KV k="Delegated by" v={<Link href={`/agents/runs/${d.parent.run.id}`}>{d.parent.agentName} · {d.parent.run.task?.slice(0, 80) ?? 'run'}</Link>} />}
          {d.children.map((c) => (
            <div key={c.run.id} className="lc-kv">
              <span className="lc-row" style={{ gap: 8 }}>
                <Icon name="subdirectory_arrow_right" size={16} />
                <Link href={`/agents/runs/${c.run.id}`}>{c.agentName}</Link>
                <span className="lc-cell-sub lc-ellipsis" style={{ maxWidth: 420 }}>{c.run.task}</span>
              </span>
              <span className="lc-row" style={{ gap: 8 }}>
                <span className="lc-mono" style={{ fontSize: 12 }}>{usd(c.run.costUsd)}</span>
                <RunChip status={c.run.status} />
              </span>
            </div>
          ))}
        </Card>
      )}

      <Card title="Activity" sub={active ? 'Updates live as the agent works.' : undefined}>
        {d.steps.length === 0 ? <span className="lc-muted" style={{ fontSize: 13 }}>Waiting for a worker to pick this up…</span> : d.steps.map((s) => <StepRow key={s.id} s={s} />)}
      </Card>
      <span className="lc-row" style={{ gap: 12 }}>
        {d.agent && <Link href={`/agents/${d.agent.id}`} className="lc-btn lc-btn--link"><Icon name="smart_toy" />{d.agent.name}</Link>}
        <Link href="/agents/runs" className="lc-btn lc-btn--link"><Icon name="arrow_back" />All runs</Link>
      </span>
    </Page>
  );
}
