import Link from 'next/link';
import type { PageProps } from '@labelconsole/core/web';
import { Card, Chip, DataTable, Page, PageHeader, Progress, fmt } from '@labelconsole/ui';
import { FormModal, PollUntilDone, UploadZone } from '@labelconsole/ui/client';
import * as svc from '../service';
import { ImportBox } from './import-client';

export default async function ImportPage({ run }: PageProps) {
  const { lookups, imports } = await run(async (ctx) => ({ lookups: await svc.recentLookups(ctx), imports: await svc.recentImports(ctx) }));
  const running = imports.find((i) => i.status === 'queued' || i.status === 'running');
  return (
    <Page>
      <PageHeader
        title="Track import"
        description="Paste a link or code. We look it up across Deezer, MusicBrainz, iTunes and any catalogue APIs you have connected, show where sources disagree, and guess the distributor with evidence."
        actions={<FormModal title="Bulk import" description="A CSV with a column named isrc or upc (or codes in the first column). Runs in the background." trigger={{ label: 'Bulk import CSV', icon: 'upload_file' }} endpoint="/metadata/imports" multipart fields={[{ name: 'file', label: 'CSV file', type: 'file', accept: '.csv,text/csv', required: true, full: true }, { name: 'autoConfirm', label: 'Create records automatically when sources agree (otherwise stop for review)', type: 'checkbox', full: true }]} success="Import started" />}
      />
      <Card>
        <ImportBox />
        <div style={{ marginTop: 14 }}>
          <UploadZone endpoint="/metadata/resolve-file" accept="audio/*" multiple={false} compact label="Or drop an audio file to read its embedded ISRC and tags" redirectTo="/catalog/import/{id}" />
        </div>
      </Card>
      {running && <PollUntilDone endpoint={`/metadata/imports/${running.id}`} done={['done', 'failed']} intervalMs={2500} />}
      {imports.length > 0 && (
        <DataTable
          title="Bulk imports and Spotify syncs"
          rows={imports}
          rowKey={(i) => i.id}
          rowHref={(i) => (i.kind === 'spotify' && i.meta.artistId ? `/people/artists/${i.meta.artistId}` : undefined)}
          minWidth={820}
          columns={[
            { key: 'when', header: 'Started', width: '120px', render: (i) => <span>{fmt.relative(i.createdAt)}</span> },
            { key: 'src', header: 'Source', width: 'minmax(160px,1fr)', render: (i) => <span className="lc-ellipsis">{i.kind === 'spotify' ? `Spotify · ${i.meta.artistName ?? 'artist'}${i.meta.onlyLabel ? ' (label only)' : ''}` : 'CSV of codes'}</span> },
            { key: 'progress', header: 'Progress', width: 'minmax(200px,1fr)', render: (i) => <span className="lc-row" style={{ gap: 10 }}><Progress value={(i.processed / Math.max(1, i.total)) * 100} width={120} /><span className="lc-mono" style={{ fontSize: 12 }}>{i.processed}/{i.total}</span></span> },
            { key: 'ok', header: 'Found', width: '80px', align: 'right', render: (i) => <span className="lc-cell-num">{i.succeeded}</span> },
            { key: 'bad', header: 'Not found', width: '90px', align: 'right', render: (i) => <span className="lc-cell-num">{i.failed}</span> },
            { key: 'skip', header: 'Left out', width: '80px', align: 'right', render: (i) => <span className="lc-cell-num lc-muted">{i.items.filter((x) => x.status === 'skipped').length || '—'}</span> },
            { key: 'status', header: 'Status', width: '110px', render: (i) => <Chip tone={i.status === 'done' ? 'blue' : 'neutral'}>{fmt.titleCase(i.status)}</Chip> },
          ]}
        />
      )}
      <DataTable
        title="Recent lookups"
        rows={lookups}
        rowKey={(l) => l.id}
        rowHref={(l) => (l.status === 'confirmed' && l.releaseId ? `/catalog/releases/${l.releaseId}` : `/catalog/import/${l.id}`)}
        minWidth={720}
        empty="Nothing looked up yet."
        columns={[
          { key: 'input', header: 'Input', width: 'minmax(220px,1.3fr)', render: (l) => <span className="lc-mono lc-ellipsis" style={{ fontSize: 12 }}>{l.input.input ?? 'Audio file tags'}</span> },
          { key: 'found', header: 'Found', width: 'minmax(200px,1fr)', render: (l) => <span className="lc-ellipsis">{l.result ? `${l.result.title ?? l.result.releaseTitle ?? '—'} · ${l.result.artists.join(', ')}` : l.error ?? '—'}</span> },
          { key: 'status', header: 'Status', width: '120px', render: (l) => <Chip tone={l.status === 'confirmed' ? 'blue' : l.status === 'failed' ? 'red' : 'neutral'}>{l.status === 'done' ? 'Ready to review' : fmt.titleCase(l.status)}</Chip> },
          { key: 'when', header: 'When', width: '110px', render: (l) => <span className="lc-muted">{fmt.relative(l.createdAt)}</span> },
        ]}
      />
      <p className="lc-note">
        ISRC and UPC lookups use public catalogue APIs and the integrations you connect. To bring in everything an artist has on Spotify, use <strong>Sync from Spotify</strong> on their page under <Link href="/people/artists">Artists</Link>. Play counts for imported tracks come from the <Link href="/streams">Streams</Link> module.
      </p>
    </Page>
  );
}
