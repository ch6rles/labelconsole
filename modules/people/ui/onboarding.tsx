import type { PageProps } from '@labelconsole/core/web';
import { InlineNote, Page, PageHeader, Progress, Summary, fmt } from '@labelconsole/ui';
import { FormModal } from '@labelconsole/ui/client';
import Link from 'next/link';
import * as svc from '../service';
import { OnboardingSteps } from './onboarding-client';

export default async function OnboardingPage({ run, session }: PageProps) {
  const board = await run((ctx) => svc.onboardingBoard(ctx));
  const missingPayout = board.filter((b) => !b.artist.onboarding.payout).length;
  const durations = board.filter((b) => b.done === b.total && b.artist.onboardingStartedAt).map((b) => fmt.daysBetween(b.artist.onboardingStartedAt!));
  const canWrite = session.permissions.has('people:write');
  return (
    <Page>
      <PageHeader
        title="Onboarding"
        description="New signings working through intake. Nothing ships until every step is in."
        actions={canWrite && <FormModal title="Start onboarding" trigger={{ label: 'Add artist to onboarding', icon: 'person_add', variant: 'primary' }} endpoint="/people/artists" extra={{ status: 'onboarding' }} fields={[{ name: 'name', label: 'Artist name', required: true }, { name: 'legalName', label: 'Legal name' }, { name: 'email', label: 'Email', type: 'email' }, { name: 'country', label: 'Country (ISO code)' }]} success="Onboarding started" />}
      />
      <Summary>
        {board.length} in progress · {missingPayout} missing payout details{durations.length ? ` · median ${durations.sort((a, b) => a - b)[Math.floor(durations.length / 2)]} days to complete` : ''}
      </Summary>
      <div className="lc-table-wrap">
        <div style={{ minWidth: 1080 }}>
          <div className="lc-table-grid lc-table-head" style={{ gridTemplateColumns: 'minmax(200px,1.2fr) 440px 130px minmax(200px,1fr)' }}>
            <span>Artist</span>
            <span style={{ display: 'grid', gridTemplateColumns: 'repeat(5,1fr)', textAlign: 'center' }}>
              <span>Profile</span>
              <span>Tax form</span>
              <span>Payout</span>
              <span>Contract</span>
              <span>Assets</span>
            </span>
            <span>Progress</span>
            <span>Next step</span>
          </div>
          {board.map((b) => (
            <div key={b.artist.id} className="lc-table-grid lc-table-row" style={{ gridTemplateColumns: 'minmax(200px,1.2fr) 440px 130px minmax(200px,1fr)', padding: '14px 16px' }}>
              <span className="lc-cell-stack">
                <Link href={`/people/artists/${b.artist.id}`} className="lc-cell-strong" style={{ color: 'var(--lc-ink)' }}>
                  {b.artist.name}
                </Link>
                <span className="lc-cell-sub">
                  Started {b.artist.onboardingStartedAt ? fmt.shortDate(b.artist.onboardingStartedAt) : '—'}
                  {b.owner ? ` · A&R ${b.owner}` : ''}
                </span>
              </span>
              <OnboardingSteps artistId={b.artist.id} steps={b.steps} disabled={!canWrite} />
              <span className="lc-row" style={{ gap: 10 }}>
                <Progress value={(b.done / b.total) * 100} width={64} />
                <span className="lc-mono" style={{ fontSize: 12, color: 'var(--lc-text-2)' }}>
                  {b.done}/{b.total}
                </span>
              </span>
              <span style={{ fontSize: 13, color: 'var(--lc-text-2)' }}>{b.next}</span>
            </div>
          ))}
          {board.length === 0 && <div className="lc-table-empty">Nobody is onboarding right now.</div>}
        </div>
      </div>
      <InlineNote>Tick each step as it lands. Release readiness reads the same contract and asset status.</InlineNote>
    </Page>
  );
}
