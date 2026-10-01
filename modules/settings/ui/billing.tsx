import type { PageProps } from '@labelconsole/core/web';
import { Card, Page, PageHeader, Progress, StatCard, fmt } from '@labelconsole/ui';
import * as svc from '../service';

const GB = 1024 ** 3;
const bytes = (n: number) => (n >= GB ? `${(n / GB).toFixed(n >= 10 * GB ? 0 : 1)} GB` : `${Math.round(n / 1024 ** 2)} MB`);

export default async function BillingPage({ run }: PageProps) {
  const u = await run((ctx) => svc.planUsage(ctx));
  const budgetNote = u.monthlyBudgetUsd != null ? `of ${fmt.usd(u.monthlyBudgetUsd)} monthly cap` : 'no label-wide cap set';
  const rows: Array<{ label: string; used: number | undefined; limit: number; show: (n: number) => string; note: string }> = [
    { label: 'Team members', used: u.used.seats, limit: u.limits.seats, show: String, note: 'Active members plus open invitations' },
    { label: 'Tracked tracks', used: u.used.trackedTracks, limit: u.limits.trackedTracks, show: fmt.int, note: 'Tracks the stream tracker polls; paused tracks don’t count' },
    { label: 'File storage', used: u.used.storageBytes, limit: u.limits.storageBytes, show: bytes, note: 'Drive files, documents, artwork and audio' },
  ];
  return (
    <Page variant="narrow">
      <PageHeader title="Plan & usage" description="What your plan includes and what this month has used so far." />
      <div className="lc-grid-stats">
        <StatCard label="Plan" icon="workspace_premium" value={u.planLabel} note={`${u.modulesInPlan.length} modules included`} />
        <StatCard label="Seats" icon="group" value={`${u.seats} / ${u.limits.seats}`} note="members and open invitations" />
        <StatCard label={`Agent spend · ${u.month}`} icon="smart_toy" value={fmt.usd(u.agentSpendUsd)} note={budgetNote} />
        <StatCard label="Agent runs" icon="bolt" value={fmt.int(u.agentRuns)} note={`${fmt.compact(u.llmTokens)} tokens`} />
      </div>
      <Card title="Plan limits" sub="Checked only when something is added: nothing you already have is ever switched off.">
        {rows.map((r) => {
          const pct = r.used == null ? 0 : (r.used / r.limit) * 100;
          return (
            <div key={r.label} className="lc-kv" style={{ alignItems: 'center', gap: 16 }}>
              <span className="lc-cell-stack">
                <span>{r.label}</span>
                <span className="lc-cell-sub">{r.used == null ? 'Module not enabled' : r.note}</span>
              </span>
              <span className="lc-row" style={{ gap: 12, flexWrap: 'nowrap' }}>
                <span className="lc-mono" style={{ fontSize: 12, whiteSpace: 'nowrap' }}>
                  {r.used == null ? '—' : r.show(r.used)} / {r.show(r.limit)}
                </span>
                <Progress value={pct} width={120} tone={pct >= 90 ? 'red' : 'blue'} />
              </span>
            </div>
          );
        })}
      </Card>
      <Card title="Included modules">
        <div className="lc-row" style={{ gap: 6 }}>
          {u.modulesInPlan.map((m) => (
            <span key={m} className="lc-chip">
              {m}
            </span>
          ))}
        </div>
      </Card>
      <p className="lc-note">Agent spend is priced per step from the model price table and counts against per-run, per-agent daily and label monthly budgets. Plan changes are handled with your account contact; no card is stored in Label Console.</p>
    </Page>
  );
}
