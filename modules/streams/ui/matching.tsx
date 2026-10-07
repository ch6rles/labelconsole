import Link from 'next/link';
import type { PageProps } from '@labelconsole/core/web';
import { DataTable, Page, PageHeader, Summary, fmt } from '@labelconsole/ui';
import { ActionButton, FormModal } from '@labelconsole/ui/client';
import * as svc from '../service';

/** Human review for YouTube matches the resolver wasn't sure about, and tracks it couldn't match on Spotify or YouTube. */
export default async function StreamMatchingPage({ run }: PageProps) {
  const q = await run((ctx) => svc.matchingQueue(ctx));
  return (
    <Page>
      <PageHeader title="Matching" description="The resolver finds each track on Spotify by ISRC and searches YouTube once. Exact and confident matches are confirmed automatically; the rest wait here. Confirm, reject, or paste the right link." />
      <Summary>
        {q.pending.length} suggested matches to review · {q.unmatched.length} tracks without a match
      </Summary>
      <DataTable
        title="Suggested matches"
        rows={q.pending}
        rowKey={(r) => r.identity.id}
        minWidth={900}
        empty="Nothing to review."
        columns={[
          { key: 't', header: 'Track', width: 'minmax(200px,1.2fr)', render: (r) => <span className="lc-cell-stack"><Link href={`/streams/tracks/${r.identity.entityId}`} className="lc-cell-strong" style={{ color: 'var(--lc-ink)' }}>{r.title}</Link><span className="lc-cell-sub">{r.artists.join(', ') || '—'}{r.durationMs ? ` · ${fmt.duration(r.durationMs)}` : ''}</span></span> },
          {
            key: 'v',
            header: 'YouTube video',
            width: 'minmax(200px,1fr)',
            render: (r) => (
              <span className="lc-cell-stack">
                <a href={r.identity.url ?? `https://www.youtube.com/watch?v=${r.identity.externalId}`} target="_blank" rel="noreferrer" className="lc-mono" style={{ fontSize: 13 }}>youtube.com/watch?v={r.identity.externalId}</a>
                <span className="lc-cell-sub">{r.identity.variant === 'topic' ? 'YouTube Music art track' : 'Official video'}</span>
              </span>
            ),
          },
          { key: 'c', header: 'Confidence', width: '110px', align: 'right', render: (r) => <span className="lc-cell-num">{Math.round(Number(r.identity.confidence) * 100)}%</span> },
          {
            key: 'a',
            header: '',
            width: '200px',
            align: 'right',
            render: (r) => (
              <span className="lc-row" style={{ gap: 6, justifyContent: 'flex-end', flexWrap: 'nowrap' }}>
                <ActionButton endpoint={`/streams/matching/${r.identity.id}`} body={{ status: 'confirmed' }} label="Confirm" icon="check" size="sm" variant="primary" success="Match confirmed" />
                <ActionButton endpoint={`/streams/matching/${r.identity.id}`} body={{ status: 'rejected' }} label="Reject" size="sm" variant="ghost" success="Match rejected" />
              </span>
            ),
          },
        ]}
      />
      <DataTable
        title="No match yet"
        rows={q.unmatched}
        rowKey={(r) => r.st.trackId}
        minWidth={900}
        empty="Every tracked track has a Spotify or YouTube match."
        columns={[
          { key: 't', header: 'Track', width: 'minmax(200px,1.2fr)', render: (r) => <span className="lc-cell-stack"><Link href={`/streams/tracks/${r.st.trackId}`} className="lc-cell-strong" style={{ color: 'var(--lc-ink)' }}>{r.title}</Link><span className="lc-cell-sub">{r.artists.join(', ') || '—'}{r.isrc ? ` · ${r.isrc}` : ''}</span></span> },
          { key: 'w', header: 'Why', width: 'minmax(220px,1.2fr)', render: (r) => <span className="lc-cell-sub">{r.st.lastError ?? (r.st.lastResolvedAt ? 'No confident match' : 'Search queued')}</span> },
          { key: 'r', header: 'Last search', width: '120px', render: (r) => <span className="lc-mono" style={{ fontSize: 12, color: 'var(--lc-muted)' }}>{r.st.lastResolvedAt ? fmt.relative(r.st.lastResolvedAt) : '—'}</span> },
          {
            key: 'a',
            header: '',
            width: '320px',
            align: 'right',
            render: (r) => (
              <span className="lc-row" style={{ gap: 6, justifyContent: 'flex-end', flexWrap: 'nowrap' }}>
                <FormModal title={`Spotify track for ${r.title}`} trigger={{ label: 'Spotify', icon: 'link', size: 'sm' }} endpoint={`/streams/registry/${r.st.trackId}/spotify`} fields={[{ name: 'spotify', label: 'Spotify link', required: true, full: true, placeholder: 'https://open.spotify.com/track/…' }]} columns={1} success="Spotify track set" />
                <FormModal title={`YouTube video for ${r.title}`} trigger={{ label: 'YouTube', icon: 'link', size: 'sm' }} endpoint={`/streams/registry/${r.st.trackId}/youtube`} fields={[{ name: 'video', label: 'YouTube link', required: true, full: true }]} columns={1} success="Video added" />
                <ActionButton endpoint={`/streams/registry/${r.st.trackId}/resolve`} label="Search" icon="travel_explore" size="sm" variant="ghost" success="Search queued" />
              </span>
            ),
          },
        ]}
      />
    </Page>
  );
}
