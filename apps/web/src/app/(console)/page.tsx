import { logger } from '@labelconsole/core/logger';
import { modules, type AttentionItem, type HealthStat } from '@labelconsole/core/modules';
import { AttentionList, Icon, Page, PageHeader, Section, StatCard } from '@labelconsole/ui';
import { getEnabledModules, requireSession, runAs } from '@/server/session';

export const metadata = { title: 'Dashboard' };

export default async function DashboardPage() {
  const session = await requireSession();
  const enabled = await getEnabledModules(session);
  const active = modules().filter((m) => enabled.has(m.manifest.id));

  const { attention, stats } = await runAs(session)(async (ctx) => {
    const attention: AttentionItem[] = [];
    const stats: HealthStat[] = [];
    for (const m of active) {
      try {
        if (m.attention) attention.push(...(await m.attention(ctx)));
        if (m.stats) stats.push(...(await m.stats(ctx)));
      } catch (err) {
        logger.warn({ err, module: m.manifest.id }, 'dashboard provider failed');
      }
    }
    return { attention, stats };
  });

  const open = attention.filter((a) => a.n > 0).sort((a, b) => (a.tone === b.tone ? b.n - a.n : a.tone === 'red' ? -1 : 1));
  const clear = attention.filter((a) => a.n === 0);
  const health = stats.filter((s) => s.group === 'health');
  const reach = stats.filter((s) => s.group === 'marketing');

  return (
    <Page variant="dashboard">
      <PageHeader title="Dashboard" description={`${session.org.name} · Label operations overview`} large />

      <Section title="Needs attention" aside={`${open.length} item${open.length === 1 ? '' : 's'}`}>
        <AttentionList
          rows={open.map((a) => ({ n: a.n, tone: a.tone, title: a.title, sub: a.sub, href: a.href }))}
          empty={<div className="lc-empty"><Icon name="check_circle" /><span className="lc-empty-title">Nothing needs attention</span></div>}
        />
        {clear.length > 0 && (
          <div className="lc-inline-note">
            <Icon name="check" />
            <span>Clear: {clear.map((c) => c.title.toLowerCase()).join(', ')}</span>
          </div>
        )}
      </Section>

      {health.length > 0 && (
        <Section title="Health">
          <div className="lc-grid-stats">
            {health.map((h) => (
              <StatCard key={h.label} label={h.label} icon={h.icon} value={h.value} delta={h.delta} deltaDown={h.delta?.startsWith('−')} note={h.note} />
            ))}
          </div>
        </Section>
      )}

      {reach.length > 0 && (
        <Section title="Marketing">
          <div className="lc-grid-stats">
            {reach.map((h) => (
              <StatCard key={h.label} label={h.label} icon={h.icon} value={h.value} note={h.note} />
            ))}
          </div>
        </Section>
      )}
    </Page>
  );
}
