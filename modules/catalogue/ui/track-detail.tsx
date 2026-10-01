import { listArtists } from '@labelconsole/people/service';
import type { PageProps } from '@labelconsole/core/web';
import { downloadUrl, getFilesByIds } from '@labelconsole/drive/service';
import { Card, Chip, Icon, KV, Page, PageHeader, SplitBar, fmt } from '@labelconsole/ui';
import { ActionButton, FormModal, UploadZone } from '@labelconsole/ui/client';
import Link from 'next/link';
import * as svc from '../service';
import { trackFields } from './fields';
import { SignToggle, SplitEditor } from './client';

const ROLES = ['Producer', 'Songwriter', 'Composer', 'Lyricist', 'Mixing engineer', 'Mastering engineer', 'Featured artist', 'Performer', 'Arranger', 'Recording engineer'];

export default async function TrackDetailPage({ run, params, session, panels }: PageProps) {
  const data = await run(async (ctx) => {
    const d = await svc.getTrack(ctx, params.id);
    const [audio] = d.track.audioFileId ? await getFilesByIds(ctx, [d.track.audioFileId]) : [];
    const audioUrl = audio && audio.status === 'ready' ? await downloadUrl(ctx, audio.id, { inline: true }).catch(() => null) : null;
    const artistOptions = ctx.can('people:read') ? (await listArtists(ctx)).map((a) => ({ value: a.id, label: a.name })) : [];
    return { ...d, audio, audioUrl, artistOptions };
  });
  const t = data.track;
  const canWrite = session.permissions.has('catalogue:write');
  const master = data.splitSheets.find((s) => s.kind === 'master');
  const rendered = await Promise.all(panels('track').map(async (p) => ({ id: p.id, title: p.title, node: await p.component({ entityId: t.id, run, session }) })));
  return (
    <Page>
      <PageHeader
        title={`${t.title}${t.version ? ` (${t.version})` : ''}`}
        description={`${data.artists.map((a) => a.name).join(', ') || 'No artist linked'}${t.isrc ? ` · ISRC ${svc.formatIsrc(t.isrc)}` : ' · No ISRC'}`}
        actions={canWrite && <FormModal title="Edit track" trigger={{ label: 'Edit track', icon: 'edit', variant: 'primary' }} endpoint={`/catalogue/tracks/${t.id}`} method="PATCH" fields={trackFields(data.artistOptions)} initial={{ ...t, isrc: svc.formatIsrc(t.isrc), artistIds: data.artists.map((a) => a.id) }} wide />}
      />
      {t.blockers.length > 0 ? (
        <div className="lc-banner is-warn"><Icon name="block" /><div>Blocked: {t.blockers.join(' · ')}</div></div>
      ) : (
        <div className="lc-banner"><Icon name="check_circle" /><div>Ready for delivery.</div></div>
      )}
      <div className="lc-grid-2">
        <Card title="Audio">
          {data.audioUrl ? <audio controls src={data.audioUrl} style={{ width: '100%' }} /> : <p className="lc-note">No master uploaded yet.</p>}
          {data.audio && <KV k="File" v={`${data.audio.name} · ${fmt.bytes(data.audio.size)}`} />}
          {canWrite && <div style={{ marginTop: 12 }}><UploadZone endpoint={`/catalogue/tracks/${t.id}/audio`} accept="audio/*" multiple={false} label={data.audio ? 'Replace master' : 'Upload master (WAV, FLAC, AIFF or MP3)'} compact /></div>}
        </Card>
        <Card title="Details">
          <KV k="Length" v={fmt.duration(t.durationMs)} />
          <KV k="Explicit" v={t.explicit ? 'Yes' : 'No'} />
          <KV k="Genre" v={t.genre ?? '—'} />
          <KV k="BPM / key" v={[t.bpm, t.musicalKey].filter(Boolean).join(' · ') || '—'} />
          <KV k="Releases" v={data.releases.length ? data.releases.map((r) => <Link key={r.id} href={`/catalog/releases/${r.id}`} style={{ marginLeft: 6 }}>{r.title}</Link>) : '—'} />
          {data.identities.filter((i) => i.status !== 'rejected').map((i) => (
            <KV key={i.id} k={fmt.titleCase(i.platform)} v={<span>{i.url ? <a href={i.url} target="_blank" rel="noreferrer">{i.externalId}</a> : i.externalId}{i.status === 'pending_review' && <Chip tone="neutral">needs review</Chip>}</span>} />
          ))}
        </Card>
      </div>
      <Card
        title="Credits"
        actions={
          canWrite && (
            <span className="lc-row" style={{ gap: 6 }}>
              <ActionButton endpoint={`/catalogue/tracks/${t.id}/credits/import`} label="From Spotify" icon="download" size="sm" variant="ghost" success="Import queued: Spotify credits appear in a few seconds" />
              <FormModal title="Add credit" trigger={{ label: 'Add credit', icon: 'add', size: 'sm' }} endpoint={`/catalogue/tracks/${t.id}/credits`} fields={[{ name: 'name', label: 'Name', required: true }, { name: 'role', label: 'Role', type: 'select', required: true, options: ROLES.map((r) => ({ value: r, label: r })) }]} initial={{ role: 'Producer' }} />
            </span>
          )
        }
      >
        {data.credits.length === 0 ? <p className="lc-note">No credits yet. DSPs and PROs need at least the writers and producers.</p> : data.credits.map((c) => (
          <div key={c.id} className="lc-kv">
            <span>{c.name} <span className="lc-muted">· {c.role}</span></span>
            {canWrite && <ActionButton iconOnly icon="close" title="Remove credit" endpoint={`/catalogue/credits/${c.id}`} method="DELETE" variant="danger" />}
          </div>
        ))}
      </Card>
      <Card title="Master split sheet" sub="Who owns what share of the master. Unsigned sheets hold back payment on this track.">
        {master && (
          <div className="lc-stack" style={{ marginBottom: 16 }}>
            <SplitBar parts={master.parties.map((p) => ({ name: p.name, pct: Number(p.sharePct) }))} />
            {master.parties.map((p) => (
              <div key={p.id} className="lc-kv">
                <span>{p.name} <span className="lc-mono lc-muted">{Number(p.sharePct)}%</span>{p.signedAt && <span className="lc-muted" style={{ fontSize: 12 }}> · signed {fmt.shortDate(p.signedAt)}</span>}</span>
                <SignToggle partyId={p.id} signed={Boolean(p.signedAt)} disabled={!canWrite} />
              </div>
            ))}
            <span className="lc-mono lc-muted" style={{ fontSize: 12 }}>Status: {fmt.titleCase(master.status)}{master.sentAt ? ` · sent ${fmt.shortDate(master.sentAt)}` : ''}</span>
          </div>
        )}
        {canWrite && (
          <details open={!master}>
            <summary style={{ cursor: 'pointer', fontSize: 13, marginBottom: 12 }}>{master ? 'Change shares (voids signatures)' : 'Create split sheet'}</summary>
            <SplitEditor trackId={t.id} kind="master" initial={(master?.parties ?? []).map((p) => ({ name: p.name, email: p.email, sharePct: Number(p.sharePct) }))} />
          </details>
        )}
      </Card>
      {rendered.map((p) => (
        <section key={p.id} className="lc-section">
          <h2 className="lc-h2" style={{ fontSize: 17 }}>{p.title}</h2>
          {p.node}
        </section>
      ))}
      {session.permissions.has('catalogue:delete') && <div><ActionButton endpoint={`/catalogue/tracks/${t.id}`} method="DELETE" label="Delete track" icon="delete" variant="ghost" confirm={`Delete "${t.title}"?`} redirectTo="/catalog/tracks" /></div>}
    </Page>
  );
}
