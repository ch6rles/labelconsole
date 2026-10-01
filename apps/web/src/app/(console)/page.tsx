import { logger } from '@labelconsole/core/logger';
import { modules, type AttentionItem, type HealthStat, type OnboardingStep } from '@labelconsole/core/modules';
import Link from 'next/link';
import { AttentionList, Icon, Page, PageHeader, Progress, Section, StatCard } from '@labelconsole/ui';
import { ActionButton } from '@labelconsole/ui/client';
import { getEnabledModules, requireSession, runAs } from '@/server/session';

export const metadata = { title: 'Dashboard' };

export default async function DashboardPage() {
  const session = await requireSession();
  const enabled = await getEnabledModules(session);
  const active = modules().filter((m) => enabled.has(m.manifest.id));

  const hidden = Boolean((session.org.settings as { onboardingHiddenAt?: string | null }).onboardingHiddenAt);
  const { attention, stats, steps } = await runAs(session)(async (ctx) => {
    const attention: AttentionItem[] = [];
    const stats: HealthStat[] = [];
    const steps: OnboardingStep[] = [];
    for (const m of active) {
      try {
        if (m.attention) attention.push(...(await m.attention(ctx)));
        if (m.stats) stats.push(...(await m.stats(ctx)));
        if (!hidden && m.onboarding) steps.push(...(await m.onboarding(ctx)));
      } catch (err) {
        logger.warn({ err, module: m.manifest.id }, 'dashboard provider failed');
      }
    }
    return { attention, stats, steps: steps.sort((a, b) => a.order - b.order) };
  });
  const stepsDone = steps.filter((s) => s.done).length;
  const canHide = session.permissions.has('settings:manage');

  const open = attention.filter((a) => a.n > 0).sort((a, b) => (a.tone === b.tone ? b.n - a.n : a.tone === 'red' ? -1 : 1));
  const clear = attention.filter((a) => a.n === 0);
  const health = stats.filter((s) => s.group === 'health');
  const reach = stats.filter((s) => s.group === 'marketing');

  return (
    <Page variant="dashboard">
      <PageHeader title="Dashboard" description={`${session.org.name} · Label operations overview`} large />

      {steps.length > 0 && stepsDone < steps.length && (
        <Section
          title="Get set up"
          aside={
            <span className="lc-row" style={{ gap: 12 }}>
              <span className="lc-mono" style={{ fontSize: 12 }}>{stepsDone} of {steps.length} done</span>
              <Progress value={(stepsDone / steps.length) * 100} width={80} />
              {canHide && <ActionButton endpoint="/settings/onboarding" body={{ hidden: true }} label="Hide" variant="ghost" size="xs" success="Checklist hidden. Bring it back from Settings → Workspace." />}
            </span>
          }
        >
          <div className="lc-list lc-onboarding">
            {steps.map((s) => (
              <Link key={s.id} href={s.href} className={s.done ? 'lc-onboarding-step lc-onboarding-step--done' : 'lc-onboarding-step'}>
                <Icon name={s.done ? 'check_circle' : 'radio_button_unchecked'} />
                <span className="lc-cell-stack">
                  <span className="lc-onboarding-title">{s.title}</span>
                  <span className="lc-cell-sub">{s.sub}</span>
                </span>
                {!s.done && <Icon name="arrow_forward" />}
              </Link>
            ))}
          </div>
        </Section>
      )}

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
