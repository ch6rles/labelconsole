import Link from 'next/link';
import { listArtists } from '@labelconsole/people/service';
import type { PageProps } from '@labelconsole/core/web';
import { downloadUrl, getFilesByIds } from '@labelconsole/drive/service';
import { Card, Chip, Cover, DataTable, DateTag, Icon, KV, Page, PageHeader, Progress, StatCard, fmt } from '@labelconsole/ui';
import { ActionButton, FormModal, UploadZone } from '@labelconsole/ui/client';
import * as svc from '../service';
import { STATUS_LABEL, TYPE_LABEL, releaseFields, trackFields } from './fields';
import { ChecklistToggle } from './client';

export default async function ReleaseDetailPage({ run, params, session, panels, searchParams }: PageProps) {
  const data = await run(async (ctx) => {
    const d = await svc.getRelease(ctx, params.id);
    const [art] = d.release.artworkFileId ? await getFilesByIds(ctx, [d.release.artworkFileId]) : [];
    const cover = art && art.status === 'ready' ? await downloadUrl(ctx, art.id, { inline: true }).catch(() => null) : null;
    const artistOptions = ctx.can('people:read') ? (await listArtists(ctx)).map((a) => ({ value: a.id, label: a.name })) : [];
    return { ...d, cover, artistOptions };
  });
  const { release: r, readiness } = data;
  const canWrite = session.permissions.has('catalogue:write');
  const rendered = await Promise.all(panels('release').map(async (p) => ({ id: p.id, title: p.title, node: await p.component({ entityId: r.id, run, session }) })));
  const auto = [
    { label: 'Artwork uploaded', done: Boolean(r.artworkFileId) },
    { label: 'Release date set', done: Boolean(r.releaseDate) },
    { label: 'UPC assigned', done: Boolean(r.upc) },
    { label: 'Tracks added', done: readiness.trackCount > 0 },
    { label: 'All tracks ready (ISRC, audio, credits, signed splits)', done: readiness.trackCount > 0 && readiness.blockedTracks === 0 },
  ];
  const upcoming = r.status !== 'live' && (!r.releaseDate || r.releaseDate >= new Date().toISOString().slice(0, 10));

  return (
    <Page>
      <PageHeader
        title={
          <span className="lc-row" style={{ gap: 14 }}>
            <Cover src={data.cover} />
            {r.title}
          </span>
        }
        description={`${TYPE_LABEL[r.type]} · ${data.artists.map((a) => a.name).join(', ') || 'No artist linked'}${r.upc ? ` · UPC ${svc.displayUpc(r.upc)}` : ''}`}
        actions={
          canWrite && (
            <>
              <FormModal title="Add track" trigger={{ label: 'Add track', icon: 'add' }} endpoint="/catalogue/tracks" extra={{ releaseId: r.id }} fields={trackFields(data.artistOptions)} initial={{ artistIds: data.artists.map((a) => a.id) }} success="Track added" wide />
              <FormModal title={`Edit ${r.title}`} trigger={{ label: 'Edit release', icon: 'edit', variant: 'primary' }} endpoint={`/catalogue/releases/${r.id}`} method="PATCH" fields={releaseFields(data.artistOptions)} initial={{ ...r, upc: svc.displayUpc(r.upc), artistIds: data.artists.map((a) => a.id) }} wide />
            </>
          )
        }
      />
      {searchParams.edit === '1' && canWrite && <div className="lc-inline-note"><Icon name="edit" />Use “Edit release” above to change metadata.</div>}
      <div className="lc-grid-stats">
        <StatCard label="Readiness" icon="checklist" value={<span className="lc-row" style={{ gap: 10 }}><Progress value={readiness.pct} width={80} tone={readiness.tone === 'ready' ? 'blue' : readiness.tone === 'blocked' ? 'red' : 'wait'} />{readiness.pct}%</span>} note={readiness.label} />
        <StatCard label="Release date" icon="event" value={r.releaseDate ? fmt.date(r.releaseDate) : 'TBD'} note={<DateTag kind={!r.releaseDate ? 'tbd' : upcoming ? 'upcoming' : 'released'}>{!r.releaseDate ? 'TBD' : upcoming ? 'Upcoming' : 'Released'}</DateTag>} />
        <StatCard label="Status" icon="flag" value={STATUS_LABEL[r.status]} note={r.distributor ? `via ${r.distributor}` : 'Distributor not set'} />
        <StatCard label="Tracks" icon="queue_music" value={String(readiness.trackCount)} note={readiness.blockedTracks ? `${readiness.blockedTracks} blocked` : 'none blocked'} />
      </div>
      <DataTable
        title="Tracklist"
        rows={data.tracks}
        rowKey={(t) => t.id}
        rowHref={(t) => `/catalog/tracks/${t.id}`}
        minWidth={860}
        empty="No tracks yet. Add one, or import the release from a link or UPC."
        columns={[
          { key: 'pos', header: '#', width: '40px', render: (t) => <span className="lc-cell-num lc-muted">{t.position}</span> },
          { key: 'title', header: 'Title', width: 'minmax(220px,1fr)', render: (t) => <span className="lc-cell-stack"><span className="lc-cell-strong">{t.title}{t.version ? ` (${t.version})` : ''}</span>{t.explicit && <span className="lc-cell-sub">Explicit</span>}</span> },
          { key: 'isrc', header: 'ISRC', width: '150px', render: (t) => <span className="lc-mono" style={{ fontSize: 12 }}>{svc.formatIsrc(t.isrc) ?? '—'}</span> },
          { key: 'dur', header: 'Length', width: '70px', align: 'right', render: (t) => <span className="lc-cell-num">{fmt.duration(t.durationMs)}</span> },
          { key: 'status', header: 'Status', width: 'minmax(200px,1fr)', render: (t) => (t.blockers.length ? <span className="lc-row" style={{ gap: 4 }}>{t.blockers.map((b) => <Chip key={b} tone="red">{b}</Chip>)}</span> : <Chip tone="blue">Ready</Chip>) },
        ]}
      />
      <div className="lc-grid-2">
        <Card title="Checklist" sub="Automatic checks come from the release and its tracks; the rest you tick off.">
          {auto.map((c) => (
            <div key={c.label} className="lc-kv">
              <span className="lc-row" style={{ gap: 8 }}><span className={`lc-checkbox-box${c.done ? ' is-on' : ''}`}>{c.done && <Icon name="check" />}</span>{c.label}</span>
              <span className="lc-muted" style={{ fontSize: 12 }}>automatic</span>
            </div>
          ))}
          {r.checklist.map((c) => (
            <ChecklistToggle key={c.id} releaseId={r.id} item={c} disabled={!canWrite} />
          ))}
          {canWrite && <FormModal title="Add checklist step" trigger={{ label: 'Add step', icon: 'add', size: 'xs' }} endpoint={`/catalogue/releases/${r.id}/checklist`} method="PATCH" extra={{ itemId: `custom-${Date.now().toString(36)}` }} fields={[{ name: 'label', label: 'Step', required: true, full: true }]} columns={1} />}
        </Card>
        <Card title="Metadata">
          <KV k="Label" v={r.labelName ?? '—'} />
          <KV k="Catalogue number" v={r.catalogNumber ?? '—'} />
          <KV k="℗ line" v={r.pLine ?? '—'} />
          <KV k="© line" v={r.cLine ?? '—'} />
          <KV k="Genre" v={r.genre ?? '—'} />
          <KV k="Distributor" v={r.distributor ? `${r.distributor}${r.distributorConfidence && Number(r.distributorConfidence) < 1 ? ` · ${Math.round(Number(r.distributorConfidence) * 100)}% confidence` : ''}` : '—'} />
          {r.distributorEvidence?.length ? (
            <details style={{ fontSize: 12, color: 'var(--lc-muted)', marginTop: 6 }}>
              <summary>Distributor evidence</summary>
              {r.distributorEvidence.map((e, i) => (
                <div key={i} className="lc-kv" style={{ fontSize: 12 }}>
                  <span>{e.source} · {e.signal}: “{e.value}”</span>
                  <span className="lc-mono">{e.distributor} {Math.round(e.weight * 100)}%</span>
                </div>
              ))}
            </details>
          ) : null}
        </Card>
      </div>
      <Card title="Artwork" sub="3000×3000 JPEG or PNG is what most distributors want.">
        <div className="lc-row" style={{ gap: 16, alignItems: 'flex-start' }}>
          {data.cover ? <img src={data.cover} alt="Artwork" style={{ width: 160, height: 160, objectFit: 'cover', border: '1px solid var(--lc-border)' }} /> : <Cover empty />}
          {canWrite && <div style={{ flex: 1, minWidth: 240 }}><UploadZone endpoint={`/catalogue/releases/${r.id}/artwork`} accept="image/*" multiple={false} label="Drop artwork or click to upload" /></div>}
        </div>
      </Card>
      {data.identities.length > 0 && (
        <Card title="On platforms">
          {data.identities.map((i) => (
            <KV key={i.id} k={fmt.titleCase(i.platform)} v={i.url ? <a href={i.url} target="_blank" rel="noreferrer">{i.externalId}</a> : i.externalId} />
          ))}
        </Card>
      )}
      {rendered.map((p) => (
        <section key={p.id} className="lc-section">
          <h2 className="lc-h2" style={{ fontSize: 17 }}>{p.title}</h2>
          {p.node}
        </section>
      ))}
      {session.permissions.has('catalogue:delete') && (
        <div>
          <ActionButton endpoint={`/catalogue/releases/${r.id}`} method="DELETE" label="Delete release" icon="delete" variant="ghost" confirm={`Delete "${r.title}"? Its tracks stay in the catalogue.`} redirectTo="/catalog/releases" />
        </div>
      )}
      <Link href="/catalog/releases" className="lc-btn lc-btn--link"><Icon name="arrow_back" />All releases</Link>
    </Page>
  );
}
