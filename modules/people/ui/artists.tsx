import Link from 'next/link';
import { enrich } from '@labelconsole/core/modules';
import type { PageProps } from '@labelconsole/core/web';
import { Avatar, Chip, DataTable, FilterPills, Icon, KV, Page, PageHeader, SectionLabel, Summary, fmt } from '@labelconsole/ui';
import { ActionButton, DrawerClose, Drawer, FormModal } from '@labelconsole/ui/client';
import * as svc from '../service';
import { artistFields } from './fields';
import { contractTone, label, spotifyProfileUrl, statusTone, type ArtistExtras } from './shared';

const FILTERS = [
  ['all', 'All'],
  ['active', 'Active'],
  ['onboarding', 'Onboarding'],
  ['unsigned', 'Unsigned paper'],
] as const;

export default async function ArtistsPage({ run, session, searchParams, enabled }: PageProps) {
  const filter = (searchParams.filter as (typeof FILTERS)[number][0]) ?? 'all';
  const { list, extras } = await run(async (ctx) => {
    const list = await svc.listArtists(ctx, { q: searchParams.q });
    const extras = (await enrich(ctx, enabled, 'artist', list.map((a) => a.id))) as Record<string, ArtistExtras>;
    return { list, extras };
  });
  const isUnsigned = (id: string) => ['Unsigned', 'None on file'].includes(extras[id]?.contract ?? '') && (extras[id]?.liveReleases ?? 0) > 0;
  const match = (a: (typeof list)[number]) => (filter === 'active' ? a.status === 'active' : filter === 'onboarding' ? a.status === 'onboarding' : filter === 'unsigned' ? isUnsigned(a.id) : true);
  const rows = list.filter(match);
  const counts = Object.fromEntries(FILTERS.map(([id]) => [id, list.filter((a) => (id === 'all' ? true : id === 'unsigned' ? isUnsigned(a.id) : a.status === id)).length]));
  const unsignedLive = list.reduce((n, a) => n + (isUnsigned(a.id) ? extras[a.id]?.liveReleases ?? 0 : 0), 0);
  const open = searchParams.artist ? list.find((a) => a.id === searchParams.artist) : undefined;
  const qs = (f: string) => `/people/artists${f === 'all' ? '' : `?filter=${f}`}`;
  const canWrite = session.permissions.has('people:write');
  const currency = (session.org.settings as { currency?: string }).currency ?? 'USD';
  const streams = enabled.has('streams');
  const unlinked = list.filter((a) => !spotifyProfileUrl(a.spotifyArtistId)).length;
  const listeners = (a: (typeof list)[number]) =>
    spotifyProfileUrl(a.spotifyArtistId) ? fmt.compact(extras[a.id]?.monthlyListeners ?? null) : <span className="lc-cell-sub">Not linked</span>;

  return (
    <Page>
      <PageHeader
        title="Artists"
        description="Everyone on the roster, what they have earned and what is missing from their file."
        actions={
          canWrite && (
            <>
              {streams && unlinked > 0 && <ActionButton endpoint="/streams/link-artists" body={{}} label="Find Spotify profiles" icon="travel_explore" success="Looking up Spotify profiles. Monthly listeners appear as each one is linked." />}
              <FormModal title="Add artist" trigger={{ label: 'Add artist', icon: 'add', variant: 'primary' }} endpoint="/people/artists" fields={artistFields} initial={{ status: 'prospect', payoutMethod: 'none' }} redirectTo="/people/artists/{id}" success="Artist added" />
            </>
          )
        }
      />
      <Summary>
        {list.length} artists · {counts.onboarding} onboarding · {unsignedLive} live release{unsignedLive === 1 ? '' : 's'} on unsigned paper{streams && unlinked > 0 ? ` · ${unlinked} without a Spotify profile` : ''}
      </Summary>
      <FilterPills items={FILTERS.map(([id, l]) => ({ label: l, count: counts[id], href: qs(id), active: filter === id }))} />
      <DataTable
        rows={rows}
        rowKey={(a) => a.id}
        rowHref={(a) => `/people/artists?${new URLSearchParams({ ...(filter !== 'all' ? { filter } : {}), artist: a.id })}`}
        selectedKey={open?.id}
        minWidth={1040}
        empty={list.length === 0 ? 'No artists yet. Add your first artist, or import a release to create them automatically.' : 'No artists match this filter.'}
        columns={[
          {
            key: 'artist',
            header: 'Artist',
            width: 'minmax(240px,1.6fr)',
            render: (a) => (
              <span className="lc-cell-media">
                <Avatar name={a.name} />
                <span className="lc-cell-stack">
                  <span className="lc-cell-strong">{a.name}</span>
                  <span className="lc-cell-sub lc-ellipsis">
                    {a.legalName ?? '—'} · {a.country ?? '—'}
                  </span>
                </span>
              </span>
            ),
          },
          { key: 'status', header: 'Status', width: '120px', render: (a) => <Chip tone={statusTone(a.status)}>{label(a.status)}</Chip> },
          { key: 'contract', header: 'Contract', width: '160px', render: (a) => <Chip tone={contractTone(extras[a.id]?.contract ?? '—')}>{extras[a.id]?.contract ?? '—'}</Chip> },
          { key: 'releases', header: 'Releases', width: '80px', align: 'right', render: (a) => <span className="lc-cell-num">{extras[a.id]?.releases ?? 0}</span> },
          { key: 'listeners', header: 'Monthly listeners', width: '130px', align: 'right', render: (a) => <span className="lc-cell-num">{listeners(a)}</span> },
          { key: 'streams', header: 'Streams 28d', width: '100px', align: 'right', render: (a) => <span className="lc-cell-num">{fmt.compact(extras[a.id]?.streams28d ?? null)}</span> },
          { key: 'earned', header: 'Earned 12m', width: '120px', align: 'right', render: (a) => <span className="lc-cell-num">{extras[a.id]?.earned12mCents ? fmt.moneyCents(extras[a.id]!.earned12mCents!, currency) : '—'}</span> },
          { key: 'payout', header: 'Payout', width: '100px', render: (a) => <span style={{ fontSize: 13, color: a.payoutMethod === 'none' ? 'var(--lc-danger-fg)' : 'var(--lc-text-2)' }}>{a.payoutMethod === 'none' ? 'Missing' : label(a.payoutMethod)}</span> },
          { key: 'go', header: '', width: '24px', render: () => <Icon name="chevron_right" size={18} style={{ color: 'var(--lc-faint)' }} /> },
        ]}
      />
      {open && (
        <Drawer closeHref={qs(filter)}>
          <div className="lc-drawer-head">
            <span className="lc-avatar lc-avatar--lg">{fmt.initials(open.name)}</span>
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 }}>
              <span className="lc-drawer-title">{open.name}</span>
              <div className="lc-row" style={{ gap: 6 }}>
                <Chip tone={statusTone(open.status)}>{label(open.status)}</Chip>
                <Chip tone={contractTone(extras[open.id]?.contract ?? '—')}>{extras[open.id]?.contract ?? 'No contract data'}</Chip>
              </div>
            </div>
            <DrawerClose closeHref={qs(filter)} />
          </div>
          <div className={`lc-drawer-stats${streams ? ' lc-drawer-stats--quad' : ''}`}>
            <div className="lc-drawer-stat">
              <span className="lc-drawer-stat-k">Releases</span>
              <span className="lc-drawer-stat-v">{extras[open.id]?.releases ?? 0}</span>
            </div>
            {streams && (
              <div className="lc-drawer-stat">
                <span className="lc-drawer-stat-k">Monthly listeners</span>
                <span className="lc-drawer-stat-v">{listeners(open)}</span>
              </div>
            )}
            <div className="lc-drawer-stat">
              <span className="lc-drawer-stat-k">Streams 28d</span>
              <span className="lc-drawer-stat-v">{fmt.compact(extras[open.id]?.streams28d ?? null)}</span>
            </div>
            <div className="lc-drawer-stat">
              <span className="lc-drawer-stat-k">Earned 12m</span>
              <span className="lc-drawer-stat-v">{extras[open.id]?.earned12mCents ? fmt.moneyCents(extras[open.id]!.earned12mCents!, currency, { decimals: 0 }) : '—'}</span>
            </div>
          </div>
          {streams && (
            <div className="lc-drawer-section">
              <SectionLabel>Spotify</SectionLabel>
              <KV
                k="Profile"
                v={
                  spotifyProfileUrl(open.spotifyArtistId) ? (
                    <a href={spotifyProfileUrl(open.spotifyArtistId)!} target="_blank" rel="noreferrer">
                      Open on Spotify
                    </a>
                  ) : (
                    'Not linked'
                  )
                }
                tone={spotifyProfileUrl(open.spotifyArtistId) ? undefined : 'red'}
              />
              {!spotifyProfileUrl(open.spotifyArtistId) && canWrite && (
                <div className="lc-row" style={{ gap: 8, flexWrap: 'wrap' }}>
                  <ActionButton endpoint="/streams/link-artists" body={{ artistIds: [open.id] }} label="Find on Spotify" icon="travel_explore" size="sm" success="Looking for their Spotify profile" />
                  <FormModal
                    title={`Link ${open.name} to Spotify`}
                    description="Paste the link to their Spotify artist page. Monthly listeners are read straight away, then daily."
                    trigger={{ label: 'Paste link', icon: 'link', size: 'sm' }}
                    endpoint={`/people/artists/${open.id}`}
                    method="PATCH"
                    fields={[{ name: 'spotifyArtistId', label: 'Spotify profile link', required: true, full: true, placeholder: 'https://open.spotify.com/artist/…' }]}
                    columns={1}
                    success="Spotify profile linked"
                  />
                </div>
              )}
            </div>
          )}
          <div className="lc-drawer-section">
            <SectionLabel>Contact</SectionLabel>
            <KV k="Legal name" v={open.legalName ?? '—'} />
            <KV k="Email" v={open.email ?? '—'} />
            <KV k="Management" v={open.manager ?? '—'} />
            <KV k="Country" v={open.country ?? '—'} />
          </div>
          <div className="lc-drawer-section">
            <SectionLabel>Deal</SectionLabel>
            <KV k="Agreement" v={extras[open.id]?.deal ?? '—'} />
            <KV k="Artist / label" v={extras[open.id]?.split ?? '—'} />
            <KV k="Advance" v={extras[open.id]?.advance ?? '—'} />
            <KV k="On roster since" v={open.rosterSince ? fmt.date(open.rosterSince) : '—'} />
            <KV k="Contract" v={extras[open.id]?.contract ?? '—'} tone={contractTone(extras[open.id]?.contract ?? '') === 'red' ? 'red' : undefined} />
          </div>
          <div className="lc-drawer-section">
            <SectionLabel>Payout</SectionLabel>
            <KV k="Method" v={open.payoutMethod === 'none' ? 'No payout details' : label(open.payoutMethod)} tone={open.payoutMethod === 'none' ? 'red' : undefined} />
            <KV k="Distributor" v={(session.org.settings as { distributor?: string }).distributor ?? '—'} />
          </div>
          <div className="lc-drawer-foot">
            {extras[open.id]?.contractDocumentId ? (
              <Link className="lc-btn lc-btn--block" href={`/documents/${extras[open.id]!.contractDocumentId}`}>
                <Icon name="description" />
                Open contract
              </Link>
            ) : (
              <Link className="lc-btn lc-btn--block" href={`/people/contracts?artist=${open.id}`}>
                <Icon name="description" />
                Contracts
              </Link>
            )}
            <Link className="lc-btn lc-btn--primary lc-btn--block" href={`/people/artists/${open.id}`}>
              <Icon name="open_in_full" />
              Open artist
            </Link>
          </div>
        </Drawer>
      )}
    </Page>
  );
}
