import Link from 'next/link';
import { listArtists } from '@labelconsole/people/service';
import type { PageProps } from '@labelconsole/core/web';
import { Cover, DataTable, DateTag, Icon, Page, PageHeader, Progress, Tag, fmt, type Column } from '@labelconsole/ui';
import { ActionButton, CopyButton, FilterSelect, FormModal, SearchInput } from '@labelconsole/ui/client';
import { env } from '@labelconsole/core/env';
import { getFilesByIds, downloadUrl } from '@labelconsole/drive/service';
import * as svc from '../service';
import { STATUS_LABEL, TYPE_LABEL, releaseFields } from './fields';

type Row = Awaited<ReturnType<typeof svc.listReleases>>[number] & { cover: string | null };

const TONE = {
  wait: { chip: 'lc-chip', bar: 'wait' as const },
  blocked: { chip: 'lc-chip lc-chip--red', bar: 'red' as const },
  ready: { chip: 'lc-chip lc-chip--blue', bar: 'blue' as const },
};

export default async function ReleasesPage({ run, session, searchParams }: PageProps) {
  const { rows, artistOptions, intake } = await run(async (ctx) => {
    const list = await svc.listReleases(ctx, { q: searchParams.q, type: searchParams.type as never });
    const files = await getFilesByIds(ctx, list.map((r) => r.artworkFileId).filter((x): x is string => Boolean(x)));
    const urls = Object.fromEntries(await Promise.all(files.filter((f) => f.status === 'ready').map(async (f) => [f.id, await downloadUrl(ctx, f.id, { inline: true }).catch(() => null)] as const)));
    const artistOptions = ctx.can('people:read') ? (await listArtists(ctx)).map((a) => ({ value: a.id, label: a.name })) : [];
    const intake = ctx.can('catalogue:write') ? await svc.intakeToken(ctx) : null;
    return { rows: list.map((r) => ({ ...r, cover: r.artworkFileId ? urls[r.artworkFileId] ?? null : null })) as Row[], artistOptions, intake };
  });
  const distributor = (session.org.settings as { distributor?: string }).distributor;
  const upcoming = rows.filter((r) => r.upcoming);
  const released = rows.filter((r) => !r.upcoming);
  const canWrite = session.permissions.has('catalogue:write');
  const canDelete = session.permissions.has('catalogue:delete');

  const columns: Column<Row>[] = [
    {
      key: 'readiness',
      header: 'Readiness',
      width: '220px',
      render: (r) => (
        <span className="lc-row" style={{ gap: 10, flexWrap: 'nowrap' }}>
          <Progress value={r.readiness.pct} tone={TONE[r.readiness.tone].bar} />
          <span className={TONE[r.readiness.tone].chip}>{r.readiness.label}</span>
        </span>
      ),
    },
    {
      key: 'release',
      header: 'Release',
      width: 'minmax(240px,1fr)',
      render: (r) => (
        <span className="lc-cell-media">
          <Cover src={r.cover} empty={!r.upcoming && !r.cover} />
          <span className="lc-cell-stack">
            <span className="lc-row" style={{ gap: 8, flexWrap: 'nowrap' }}>
              <Link href={`/catalog/releases/${r.id}`} className="lc-cell-strong lc-ellipsis" style={{ color: 'var(--lc-ink)' }}>
                {r.title}
              </Link>
              {r.intake && <Tag>Intake</Tag>}
            </span>
            <span className="lc-cell-sub lc-mono lc-ellipsis">
              {TYPE_LABEL[r.type]} · {r.upc ? `UPC ${svc.displayUpc(r.upc)}` : 'No UPC'}
              {r.artists.length ? ` · ${r.artists.map((a) => a.name).join(', ')}` : ''}
            </span>
          </span>
        </span>
      ),
    },
    { key: 'code', header: 'Code', width: '100px', render: (r) => <span className="lc-mono" style={{ fontSize: 13, color: 'var(--lc-text-2)' }}>{r.catalogNumber ?? '—'}</span> },
    {
      key: 'status',
      header: 'Status',
      width: '160px',
      render: (r) => <span className={r.status === 'live' ? 'lc-chip lc-chip--outline-blue' : 'lc-chip'}>{r.status === 'draft' ? `Draft at ${r.distributor ?? distributor ?? 'distributor'}` : STATUS_LABEL[r.status]}</span>,
    },
    {
      key: 'date',
      header: 'Release date',
      width: '170px',
      render: (r) => (
        <span className="lc-row" style={{ gap: 10, flexWrap: 'nowrap' }}>
          <span className="lc-mono" style={{ fontSize: 13, color: 'var(--lc-text-2)', whiteSpace: 'nowrap' }}>{r.releaseDate ? fmt.date(r.releaseDate) : '—'}</span>
          <DateTag kind={!r.releaseDate ? 'tbd' : r.upcoming ? 'upcoming' : 'released'}>{!r.releaseDate ? 'TBD' : r.upcoming ? 'Upcoming' : 'Released'}</DateTag>
        </span>
      ),
    },
    { key: 'tracks', header: 'Tracks', width: '60px', align: 'right', render: (r) => <span className="lc-cell-num">{r.readiness.trackCount}</span> },
    {
      key: 'actions',
      header: '',
      width: '100px',
      align: 'right',
      render: (r) => (
        <span className="lc-row" style={{ gap: 4, justifyContent: 'flex-end', flexWrap: 'nowrap' }}>
          {canWrite && (
            <Link href={`/catalog/releases/${r.id}?edit=1`} className="lc-icon-btn is-accent" title="Edit">
              <Icon name="edit" />
            </Link>
          )}
          {canDelete && <ActionButton iconOnly icon="delete" title="Delete" variant="danger" endpoint={`/catalogue/releases/${r.id}`} method="DELETE" confirm={`Delete "${r.title}"? Tracks stay in the catalogue.`} success="Release deleted" />}
          <Link href={`/catalog/releases/${r.id}`} className="lc-icon-btn" title="Open">
            <Icon name="chevron_right" />
          </Link>
        </span>
      ),
    },
  ];

  return (
    <Page>
      <PageHeader
        title="Releases"
        description="Everything the label has built or shipped. Readiness tells you what still blocks delivery."
        actions={
          <>
            {intake && <CopyButton text={`${env().APP_URL}/intake/${intake}`} label="Copy intake link" icon="link" />}
            {canWrite && <FormModal title="New release" trigger={{ label: 'New release', icon: 'add', variant: 'primary' }} endpoint="/catalogue/releases" fields={releaseFields(artistOptions)} initial={{ type: 'single', status: 'collecting' }} redirectTo="/catalog/releases/{id}" success="Release created" wide />}
          </>
        }
      />
      <div className="lc-toolbar">
        <SearchInput placeholder="Search title, UPC or code" />
        <FilterSelect param="type" allLabel="All types" options={Object.entries(TYPE_LABEL).map(([value, label]) => ({ value, label }))} />
        <span className="lc-toolbar-end">
          {rows.length} releases · {rows.filter((r) => r.intake && r.readiness.trackCount === 0).length} awaiting intake
        </span>
      </div>
      <DataTable
        groups={[
          { label: `Upcoming (${upcoming.length})`, rows: upcoming },
          { label: `Released (${released.length})`, rows: released },
        ]}
        rowKey={(r) => r.id}
        columns={columns}
        minWidth={1040}
        empty={searchParams.q || searchParams.type ? 'No releases match that search.' : 'No releases yet. Create one, or import from a DSP link or ISRC under Track Import.'}
      />
    </Page>
  );
}
