import Link from 'next/link';
import type { PageProps } from '@labelconsole/core/web';
import { DataTable, EmptyState, Icon, Page, PageHeader, Summary, fmt } from '@labelconsole/ui';
import * as svc from '../service';
import { ApprovalActions } from './approval-actions';
import { LiveRefresh } from './live';
import { RISK_LABEL } from './shared';

const DECISION: Record<string, { label: string; className: string }> = {
  approved: { label: 'Approved', className: 'lc-chip lc-chip--outline-blue' },
  rejected: { label: 'Rejected', className: 'lc-chip lc-chip--red' },
  expired: { label: 'Expired', className: 'lc-chip lc-chip--muted' },
};

const RISK_ICON: Record<string, string> = { write: 'edit_note', external: 'outgoing_mail', destructive: 'delete_forever', spend: 'payments', read: 'visibility' };

/** The approvals queue: risky actions agents want to take, waiting on a person. */
export default async function ApprovalsPage({ run, session }: PageProps) {
  const rows = await run((ctx) => svc.listApprovals(ctx));
  const pending = rows.filter((r) => r.approval.status === 'pending');
  const history = rows.filter((r) => r.approval.status !== 'pending');
  const canApprove = session.permissions.has('agents:approve');

  return (
    <Page>
      <LiveRefresh />
      <PageHeader title="Approvals" description="Actions agents won't take on their own: contacting people outside the label, spending money, changing or deleting records. The agent waits until someone decides." />
      <Summary>
        {pending.length} waiting · {history.filter((r) => r.approval.status === 'approved').length} approved · {history.filter((r) => r.approval.status === 'rejected').length} rejected · {history.filter((r) => r.approval.status === 'expired').length} expired
      </Summary>

      {pending.length === 0 ? (
        <EmptyState icon="task_alt" title="Nothing waiting">
          When an agent needs a decision it shows up here, in the bell, and on the run.
        </EmptyState>
      ) : (
        <div className="lc-list">
          {pending.map(({ approval: a, agentName, runTask }) => (
            <div key={a.id} className="lc-card">
              <div className="lc-card-body lc-stack" style={{ gap: 12 }}>
                <span className="lc-row" style={{ gap: 12, alignItems: 'flex-start', justifyContent: 'space-between' }}>
                  <span className="lc-row" style={{ gap: 12, alignItems: 'flex-start', flex: '1 1 360px', minWidth: 0, flexWrap: 'nowrap' }}>
                    <span className="lc-cover"><Icon name={RISK_ICON[a.risk] ?? 'gavel'} /></span>
                    <span className="lc-cell-stack" style={{ minWidth: 0 }}>
                      <span style={{ fontSize: 15, fontWeight: 500, whiteSpace: 'pre-wrap' }}>{a.preview}</span>
                      <span className="lc-cell-sub">
                        <Link href={`/agents/${a.agentId}`}>{agentName}</Link> · {RISK_LABEL[a.risk as keyof typeof RISK_LABEL] ?? a.risk} · {a.toolName} · asked {fmt.relative(a.createdAt)} · expires {fmt.relative(a.expiresAt)}
                      </span>
                      {runTask && (
                        <span className="lc-cell-sub lc-ellipsis">
                          For: <Link href={`/agents/runs/${a.runId}`}>{runTask}</Link>
                        </span>
                      )}
                    </span>
                  </span>
                  {canApprove ? <ApprovalActions id={a.id} payload={a.payload} /> : <span className="lc-muted" style={{ fontSize: 13 }}>Needs someone with approval rights</span>}
                </span>
                <details>
                  <summary className="lc-cell-sub">Exactly what it will send</summary>
                  <pre className="lc-mono" style={{ fontSize: 11, whiteSpace: 'pre-wrap', wordBreak: 'break-word', background: 'var(--lc-bg-sidebar)', padding: 10, margin: '6px 0 0', maxHeight: 320, overflow: 'auto' }}>{JSON.stringify(a.payload, null, 2)}</pre>
                </details>
              </div>
            </div>
          ))}
        </div>
      )}

      <DataTable
        title="Decided"
        rows={history}
        rowKey={(r) => r.approval.id}
        rowHref={(r) => `/agents/runs/${r.approval.runId}`}
        minWidth={900}
        empty="No decisions yet."
        columns={[
          { key: 'p', header: 'Action', width: 'minmax(260px,2fr)', render: (r) => <span className="lc-cell-stack"><span className="lc-ellipsis">{r.approval.preview}</span><span className="lc-cell-sub lc-ellipsis">{r.approval.reason ?? r.approval.toolName}{r.approval.editedPayload ? ' · edited before approval' : ''}</span></span> },
          { key: 'a', header: 'Agent', width: 'minmax(140px,1fr)', render: (r) => <span className="lc-ellipsis">{r.agentName}</span> },
          { key: 'd', header: 'Decision', width: '110px', render: (r) => <span className={DECISION[r.approval.status]?.className ?? 'lc-chip'}>{DECISION[r.approval.status]?.label ?? r.approval.status}</span> },
          { key: 'b', header: 'By', width: '140px', render: (r) => <span className="lc-ellipsis" style={{ fontSize: 13 }}>{r.decidedByName ?? (r.approval.status === 'expired' ? 'Nobody in time' : '—')}</span> },
          { key: 't', header: 'When', width: '110px', render: (r) => <span className="lc-mono" style={{ fontSize: 12, color: 'var(--lc-muted)' }}>{fmt.relative(r.approval.decidedAt ?? r.approval.createdAt)}</span> },
        ]}
      />
    </Page>
  );
}
