import type { PageProps } from '@labelconsole/core/web';
import { Banner, Card, Chip, DataTable, EmptyState, Icon, KV, Page, PageHeader, Spinner, fmt } from '@labelconsole/ui';
import { LinkButton } from '@labelconsole/ui';
import { PollUntilDone } from '@labelconsole/ui/client';
import * as svc from '../service';
import { ConfirmImport } from './import-client';

export default async function ImportReviewPage({ run, params }: PageProps) {
  const lookup = await run((ctx) => svc.getLookup(ctx, params.id));
  const r = lookup.result;
  const pending = lookup.status === 'queued' || lookup.status === 'running';
  const conflictFields = new Set(r?.conflicts.map((c) => c.field) ?? []);
  const field = (name: string, label: string, value: string | null | undefined) => (
    <KV k={<span>{label}{conflictFields.has(name) && <Chip tone="red">sources disagree</Chip>}</span>} v={value ?? '—'} tone={conflictFields.has(name) ? 'red' : undefined} />
  );
  return (
    <Page>
      <PageHeader title="Review import" description={<span className="lc-mono">{lookup.input.input ?? 'Audio file tags'}</span>} actions={<LinkButton href="/catalog/import" icon="arrow_back">Back</LinkButton>} />
      {pending && (
        <>
          <PollUntilDone endpoint={`/metadata/resolve/${lookup.id}`} done={['done', 'failed', 'confirmed']} />
          <div className="lc-empty"><Spinner /><span className="lc-empty-title">Looking this up across catalogue sources…</span><span>MusicBrainz allows one request a second, so albums can take a little while.</span></div>
        </>
      )}
      {lookup.status === 'failed' && <Banner warn icon="error">Lookup failed: {lookup.error}</Banner>}
      {lookup.status === 'confirmed' && lookup.releaseId && <Banner icon="check_circle">Imported. <a href={`/catalog/releases/${lookup.releaseId}`}>Open the release</a>.</Banner>}
      {r && (
        <>
          {!r.isrc && !r.upc && r.tracks.length === 0 ? (
            <EmptyState icon="search_off" title="Nothing found">Try an ISRC or UPC, or a DSP link.</EmptyState>
          ) : (
            <>
              {r.input.matchedBy === 'search' && <Banner icon="manage_search">This was found by searching a title, so platform matches are saved for human review rather than trusted.</Banner>}
              <div className="lc-grid-2">
                <Card title="What we found">
                  {field('title', 'Track', r.title)}
                  <KV k="Artists" v={r.artists.join(', ') || '—'} />
                  {field('isrc', 'ISRC', svc.formatIsrc(r.isrc))}
                  {field('releaseTitle', 'Release', r.releaseTitle)}
                  {field('upc', 'UPC', svc.displayUpc(r.upc))}
                  {field('releaseType', 'Type', r.releaseType)}
                  {field('releaseDate', 'Release date', r.releaseDate ? fmt.date(r.releaseDate) : null)}
                  {field('labelName', 'Label', r.labelName)}
                  {field('pLine', '℗ line', r.pLine)}
                  {field('cLine', '© line', r.cLine)}
                  {field('durationMs', 'Length', fmt.duration(r.durationMs))}
                </Card>
                <Card title="Distributor guess" sub="No DSP publishes the distributor; this is inferred from evidence. Confirm or correct it below.">
                  <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 10 }}>
                    <span className="lc-stat-value">{r.distributor.name ?? 'Unknown'}</span>
                    {r.distributor.name && <span className="lc-muted">{Math.round(r.distributor.confidence * 100)}% confidence</span>}
                  </div>
                  {r.distributor.evidence.length === 0 ? <p className="lc-note">No evidence found. The label name, ℗/© lines and UPC prefix did not match anything known yet.</p> : r.distributor.evidence.map((e, i) => (
                    <div key={i} className="lc-kv" style={{ fontSize: 12 }}>
                      <span><Icon name="fact_check" size={14} /> {e.source} · {e.signal}: “{e.value}”</span>
                      <span className="lc-mono">{e.distributor} · {Math.round(e.weight * 100)}%</span>
                    </div>
                  ))}
                </Card>
              </div>
              {r.conflicts.length > 0 && (
                <Card title="Where sources disagree" sub="The first source listed wins unless you change it below.">
                  {r.conflicts.map((c) => (
                    <div key={c.field} className="lc-kv" style={{ alignItems: 'flex-start' }}>
                      <span className="lc-kv-k">{fmt.titleCase(c.field)}</span>
                      <span className="lc-kv-v">{c.values.map((v) => <div key={v.source}><span className="lc-mono" style={{ fontSize: 12 }}>{v.source}</span>: {v.value}</div>)}</span>
                    </div>
                  ))}
                </Card>
              )}
              {r.tracks.length > 0 && (
                <DataTable
                  title={`Tracklist (${r.tracks.length})`}
                  rows={r.tracks}
                  rowKey={(t) => `${t.position}-${t.title}`}
                  minWidth={640}
                  columns={[
                    { key: 'p', header: '#', width: '40px', render: (t) => <span className="lc-cell-num lc-muted">{t.position}</span> },
                    { key: 't', header: 'Title', width: 'minmax(200px,1fr)', render: (t) => t.title },
                    { key: 'i', header: 'ISRC', width: '150px', render: (t) => <span className="lc-mono" style={{ fontSize: 12 }}>{svc.formatIsrc(t.isrc) ?? '—'}</span> },
                    { key: 'd', header: 'Length', width: '70px', align: 'right', render: (t) => <span className="lc-cell-num">{fmt.duration(t.durationMs)}</span> },
                  ]}
                />
              )}
              <Card title="Sources">
                {r.sources.map((s) => (
                  <div key={s.source} className="lc-kv">
                    <span className="lc-mono" style={{ fontSize: 12 }}>{s.source}</span>
                    <span>{s.ok ? <Chip tone="blue">matched</Chip> : s.skipped ? <span className="lc-muted" style={{ fontSize: 12 }}>{s.skipped}</span> : <span className="lc-muted" style={{ fontSize: 12 }}>{s.error}</span>}</span>
                  </div>
                ))}
                {r.platformIds.length > 0 && <div style={{ marginTop: 8, fontSize: 12, color: 'var(--lc-muted)' }}>Platform ids: {r.platformIds.map((p) => `${p.platform} ${p.entity}`).join(' · ')}</div>}
              </Card>
              {lookup.status === 'done' && (
                <Card title="Create records" sub="Creates the release, its tracks (matched by ISRC to anything already in the catalogue), artists, and platform ids, then starts stream tracking.">
                  <ConfirmImport
                    lookupId={lookup.id}
                    initial={{
                      title: r.releaseTitle ?? r.title ?? '',
                      type: r.releaseType ?? (r.tracks.length > 6 ? 'album' : r.tracks.length > 1 ? 'ep' : 'single'),
                      releaseDate: r.releaseDate && /^\d{4}-\d{2}-\d{2}$/.test(r.releaseDate) ? r.releaseDate : '',
                      labelName: r.labelName ?? '',
                      distributor: r.distributor.name ?? '',
                      artistNames: r.artists.join(', '),
                      status: r.releaseDate && r.releaseDate <= new Date().toISOString().slice(0, 10) ? 'live' : 'scheduled',
                    }}
                  />
                </Card>
              )}
            </>
          )}
        </>
      )}
    </Page>
  );
}
