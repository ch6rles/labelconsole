import type { PageProps } from '@labelconsole/core/web';
import { Card, Page, PageHeader, StatCard, fmt } from '@labelconsole/ui';
import * as svc from '../service';

export default async function BillingPage({ run }: PageProps) {
  const u = await run((ctx) => svc.planUsage(ctx));
  const budgetNote = u.monthlyBudgetUsd != null ? `of ${fmt.usd(u.monthlyBudgetUsd)} monthly cap` : 'no label-wide cap set';
  return (
    <Page variant="narrow">
      <PageHeader title="Plan & usage" description="What your plan includes and what this month has used so far." />
      <div className="lc-grid-stats">
        <StatCard label="Plan" icon="workspace_premium" value={u.planLabel} note={`${u.modulesInPlan.length} modules included`} />
        <StatCard label="Seats" icon="group" value={String(u.seats)} note="active members" />
        <StatCard label={`Agent spend · ${u.month}`} icon="smart_toy" value={fmt.usd(u.agentSpendUsd)} note={budgetNote} />
        <StatCard label="Agent runs" icon="bolt" value={fmt.int(u.agentRuns)} note={`${fmt.compact(u.llmTokens)} tokens`} />
      </div>
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
