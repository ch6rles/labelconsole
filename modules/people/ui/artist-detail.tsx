import { enrich } from '@labelconsole/core/modules';
import type { PageProps } from '@labelconsole/core/web';
import { Card, Chip, KV, Page, PageHeader, StatCard, StepBoxes, fmt } from '@labelconsole/ui';
import { ActionButton, FormModal } from '@labelconsole/ui/client';
import * as svc from '../service';
import { artistFields } from './fields';
import { contractTone, label, statusTone, type ArtistExtras } from './shared';

export default async function ArtistDetailPage({ run, params, session, panels, enabled }: PageProps) {
  const { artist, extras } = await run(async (ctx) => {
    const artist = await svc.getArtist(ctx, params.id);
    const extras = ((await enrich(ctx, enabled, 'artist', [artist.id]))[artist.id] ?? {}) as ArtistExtras;
    return { artist, extras };
  });
  const canWrite = session.permissions.has('people:write');
  const progress = svc.onboardingProgress(artist.onboarding);
  const currency = (session.org.settings as { currency?: string }).currency ?? 'USD';
  const socials = Object.entries(artist.socials).filter(([, v]) => v);
  const rendered = await Promise.all(panels('artist').map(async (p) => ({ id: p.id, title: p.title, node: await p.component({ entityId: artist.id, run, session }) })));

  return (
    <Page>
      <PageHeader
        title={
          <span className="lc-row" style={{ gap: 12 }}>
            {artist.name} <Chip tone={statusTone(artist.status)}>{label(artist.status)}</Chip>
          </span>
        }
        description={[artist.legalName, artist.country, artist.manager].filter(Boolean).join(' · ') || 'No profile details yet'}
        actions={
          canWrite && (
            <>
              <FormModal title={`Edit ${artist.name}`} trigger={{ label: 'Edit artist', icon: 'edit' }} endpoint={`/people/artists/${artist.id}`} method="PATCH" fields={artistFields} initial={artist} wide />
              {session.permissions.has('people:delete') && <ActionButton endpoint={`/people/artists/${artist.id}`} method="DELETE" icon="delete" label="Delete" variant="ghost" confirm={`Delete ${artist.name}? Releases keep their records but lose the artist link.`} redirectTo="/people/artists" />}
            </>
          )
        }
      />
      <div className="lc-grid-stats">
        <StatCard label="Releases" icon="album" value={String(extras.releases ?? 0)} note={`${extras.liveReleases ?? 0} live`} />
        <StatCard label="Streams · 28d" icon="visibility" value={fmt.compact(extras.streams28d ?? null)} note="plays from Spotify and YouTube" />
        <StatCard label="Earned · 12m" icon="payments" value={extras.earned12mCents ? fmt.moneyCents(extras.earned12mCents, currency) : '—'} note="net, from imported statements" />
        <StatCard label="Contract" icon="draft" value={<Chip tone={contractTone(extras.contract ?? '—')}>{extras.contract ?? '—'}</Chip>} note={extras.deal ?? undefined} />
      </div>
      <div className="lc-grid-2">
        <Card title="Profile">
          <KV k="Legal name" v={artist.legalName ?? '—'} />
          <KV k="Email" v={artist.email ?? '—'} />
          <KV k="Management" v={artist.manager ?? '—'} />
          <KV k="Country" v={artist.country ?? '—'} />
          <KV k="Aliases" v={artist.aliases.join(', ') || '—'} />
          <KV k="Payout" v={artist.payoutMethod === 'none' ? 'No payout details' : label(artist.payoutMethod)} tone={artist.payoutMethod === 'none' ? 'red' : undefined} />
          <KV k="On roster since" v={artist.rosterSince ? fmt.date(artist.rosterSince) : '—'} />
          <KV k="Spotify artist ID" v={artist.spotifyArtistId ?? '—'} />
          <KV k="YouTube channel" v={artist.youtubeChannelId ?? '—'} />
          {socials.map(([k, v]) => (
            <KV key={k} k={label(k)} v={String(v)} />
          ))}
        </Card>
        <Card title="Onboarding" sub={artist.status === 'onboarding' ? svc.nextStepFor(artist) : 'Profile, tax form, payout, contract and assets'}>
          <div className="lc-stack">
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5,1fr)', textAlign: 'center' }} className="lc-stat-label">
              <span>Profile</span>
              <span>Tax form</span>
              <span>Payout</span>
              <span>Contract</span>
              <span>Assets</span>
            </div>
            <StepBoxes steps={progress.steps} />
            <span className="lc-mono lc-muted" style={{ fontSize: 12 }}>
              {progress.done}/{progress.total} complete
            </span>
            {artist.notes && <p className="lc-note">{artist.notes}</p>}
          </div>
        </Card>
      </div>
      {rendered.map((p) => (
        <section key={p.id} className="lc-section">
          <h2 className="lc-h2" style={{ fontSize: 17 }}>
            {p.title}
          </h2>
          {p.node}
        </section>
      ))}
    </Page>
  );
}
