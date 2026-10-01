import Link from 'next/link';
import type { PageProps } from '@labelconsole/core/web';
import { Icon, Page, PageHeader } from '@labelconsole/ui';
import { ActionButton } from '@labelconsole/ui/client';
import { AGENT_TYPES } from '../agent-types';
import { describeCron, usd } from './shared';

/** Pick an agent type; it's created with that type's tools, approvals, budget and triggers, then opens for editing. */
export default async function NewAgentPage({ session }: PageProps) {
  const canManage = session.permissions.has('agents:manage');
  return (
    <Page>
      <PageHeader title="New agent" description="Start from a type. Everything (tools, approvals, budget, schedule) can be changed after." actions={<Link className="lc-btn" href="/agents">Cancel</Link>} />
      <div className="lc-grid-cards">
        {AGENT_TYPES.map((t) => (
          <div key={t.id} className="lc-card">
            <div className="lc-card-body lc-stack" style={{ gap: 12, height: '100%' }}>
              <span className="lc-row" style={{ gap: 10 }}>
                <span className="lc-cover"><Icon name={t.icon} /></span>
                <span className="lc-cell-strong" style={{ fontSize: 15 }}>{t.name}</span>
              </span>
              <span style={{ fontSize: 13, color: 'var(--lc-text-2)', flex: 1 }}>{t.description}</span>
              <span className="lc-cell-sub">
                {t.tools.length} tools · {usd(t.budget.perRunUsd)} per run · {t.triggers.length ? t.triggers.map((tr) => (tr.config.kind === 'cron' ? describeCron(tr.config.cron) : tr.label)).join(', ') : 'manual'}
              </span>
              <span className="lc-cell-sub">
                Asks first for: {(['write', 'external', 'destructive', 'spend'] as const).filter((r) => t.approvalPolicy.risk[r] === 'approve').join(', ') || 'nothing'}
                {(['write', 'external', 'destructive', 'spend'] as const).some((r) => t.approvalPolicy.risk[r] === 'deny') ? ' · read-only for the rest' : ''}
              </span>
              {canManage && <ActionButton endpoint="/agents/from-type" body={{ type: t.id }} label={`Create ${t.name}`} icon="add" variant="primary" redirectTo="/agents/{id}" success="Agent created" />}
            </div>
          </div>
        ))}
      </div>
    </Page>
  );
}
