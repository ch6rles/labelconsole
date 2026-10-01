import { env } from '@labelconsole/core/env';
import type { PageProps } from '@labelconsole/core/web';
import { downloadUrl } from '@labelconsole/drive/service';
import { Chip, DataTable, FilterPills, Icon, KV, Page, PageHeader, SectionLabel, Summary, fmt } from '@labelconsole/ui';
import { ActionButton, CopyButton, Drawer, DrawerClose, FormModal } from '@labelconsole/ui/client';
import { DEMO_STAGES } from '../schema';
import * as svc from '../service';

const STAGE_TONE: Record<string, 'blue' | 'neutral' | 'muted' | 'solid' | 'ink'> = { new: 'ink', reviewing: 'neutral', shortlisted: 'blue', passed: 'muted', signed: 'solid' };

export default async function DemosPage({ run, session, searchParams }: PageProps) {
  const stage = DEMO_STAGES.includes(searchParams.stage as never) ? searchParams.stage : undefined;
  const data = await run(async (ctx) => {
    const all = await svc.listDemos(ctx);
    const open = searchParams.open ? all.find((d) => d.id === searchParams.open) ?? null : null;
    const audioUrl = open?.audioFileId ? await downloadUrl(ctx, open.audioFileId, { inline: true }).catch(() => null) : null;
    const token = ctx.can('catalogue:write') ? await svc.intakeToken(ctx) : null;
    return { all, open, audioUrl, token };
  });
  const rows = stage ? data.all.filter((d) => d.stage === stage) : data.all;
  const canWrite = session.permissions.has('catalogue:write');
  const close = `/catalog/demos${stage ? `?stage=${stage}` : ''}`;
  const unreviewed = data.all.filter((d) => d.stage === 'new');
  return (
    <Page>
      <PageHeader
        title="Demos"
        description="The demo inbox. Score against the label's taste, shortlist, pass or sign."
        actions={
          <>
            {data.token && <CopyButton text={`${env().APP_URL}/intake/${data.token}`} label="Copy submission link" icon="link" />}
            {canWrite && (
              <FormModal
                title="Add demo"
                trigger={{ label: 'Add demo', icon: 'add', variant: 'primary' }}
                endpoint="/catalogue/demos"
                multipart
                fields={[
                  { name: 'title', label: 'Track title', required: true },
                  { name: 'artistName', label: 'Artist', required: true },
                  { name: 'submitterEmail', label: 'Contact email', type: 'email' },
                  { name: 'genre', label: 'Genre' },
                  { name: 'links', label: 'Links (SoundCloud, YouTube…)', type: 'tags', full: true },
                  { name: 'audio', label: 'Audio file', type: 'file', accept: 'audio/*', full: true },
                  { name: 'notes', label: 'Notes', type: 'textarea' },
                ]}
                success="Demo added"
              />
            )}
          </>
        }
      />
      <FilterPills items={[{ label: 'All', count: data.all.length, href: '/catalog/demos', active: !stage }, ...DEMO_STAGES.map((s) => ({ label: fmt.titleCase(s), count: data.all.filter((d) => d.stage === s).length, href: `/catalog/demos?stage=${s}`, active: stage === s }))]} />
      <Summary>{unreviewed.length} awaiting review{unreviewed.length ? ` · oldest ${fmt.daysBetween(unreviewed[unreviewed.length - 1].createdAt)} days` : ''}</Summary>
      <DataTable
        rows={rows}
        rowKey={(d) => d.id}
        rowHref={(d) => `/catalog/demos?${new URLSearchParams({ ...(stage ? { stage } : {}), open: d.id })}`}
        selectedKey={data.open?.id}
        minWidth={900}
        empty="No demos here. Share the submission link with artists and managers."
        columns={[
          { key: 'score', header: 'Score', width: '70px', align: 'right', render: (d) => <span className="lc-mono" style={{ fontSize: 18, fontWeight: 500, color: d.score && Number(d.score) >= 7 ? 'var(--lc-accent)' : 'var(--lc-ink)' }}>{d.score ? Number(d.score).toFixed(1) : '—'}</span> },
          { key: 'title', header: 'Demo', width: 'minmax(220px,1.4fr)', render: (d) => <span className="lc-cell-stack"><span className="lc-cell-strong">{d.title}</span><span className="lc-cell-sub">{d.artistName}{d.genre ? ` · ${d.genre}` : ''}</span></span> },
          { key: 'source', header: 'Source', width: '100px', render: (d) => <span className="lc-tag">{d.source}</span> },
          { key: 'when', header: 'Submitted', width: '120px', render: (d) => <span className="lc-muted" style={{ fontSize: 13 }}>{fmt.relative(d.createdAt)}</span> },
          { key: 'stage', header: 'Stage', width: '120px', render: (d) => <Chip tone={STAGE_TONE[d.stage]}>{fmt.titleCase(d.stage)}</Chip> },
          { key: 'go', header: '', width: '24px', render: () => <Icon name="chevron_right" size={18} style={{ color: 'var(--lc-faint)' }} /> },
        ]}
      />
      {data.open && (
        <Drawer closeHref={close}>
          <div className="lc-drawer-head">
            <span className="lc-avatar lc-avatar--lg">{fmt.initials(data.open.artistName)}</span>
            <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
              <span className="lc-drawer-title">{data.open.title}</span>
              <span className="lc-muted">{data.open.artistName}</span>
              <Chip tone={STAGE_TONE[data.open.stage]}>{fmt.titleCase(data.open.stage)}</Chip>
            </div>
            <DrawerClose closeHref={close} />
          </div>
          <div className="lc-drawer-stats">
            <div className="lc-drawer-stat"><span className="lc-drawer-stat-k">Score</span><span className="lc-drawer-stat-v">{data.open.score ? Number(data.open.score).toFixed(1) : '—'}</span></div>
            <div className="lc-drawer-stat"><span className="lc-drawer-stat-k">Fit</span><span className="lc-drawer-stat-v">{data.open.scoreDetail?.fit ?? '—'}</span></div>
            <div className="lc-drawer-stat"><span className="lc-drawer-stat-k">Potential</span><span className="lc-drawer-stat-v">{data.open.scoreDetail?.potential ?? '—'}</span></div>
          </div>
          {data.audioUrl && <div className="lc-drawer-section"><audio controls src={data.audioUrl} style={{ width: '100%' }} /></div>}
          <div className="lc-drawer-section">
            <SectionLabel>Submission</SectionLabel>
            <KV k="Contact" v={data.open.submitterEmail ?? data.open.submitterName ?? '—'} />
            <KV k="Received" v={fmt.date(data.open.createdAt)} />
            {data.open.links.map((l) => <KV key={l} k="Link" v={<a href={l} target="_blank" rel="noreferrer">{new URL(l).hostname}</a>} />)}
            {data.open.notes && <p className="lc-note" style={{ marginTop: 6 }}>{data.open.notes}</p>}
          </div>
          {data.open.scoreDetail && (
            <div className="lc-drawer-section">
              <SectionLabel>A&R notes · {data.open.scoreDetail.scoredBy}</SectionLabel>
              <p className="lc-note">{data.open.scoreDetail.rationale}</p>
            </div>
          )}
          {canWrite && (
            <div className="lc-drawer-foot" style={{ flexWrap: 'wrap' }}>
              <FormModal title="Score demo" trigger={{ label: 'Score', icon: 'star_rate', block: true }} endpoint={`/catalogue/demos/${data.open.id}/score`} initial={{ fit: data.open.scoreDetail?.fit, production: data.open.scoreDetail?.production, potential: data.open.scoreDetail?.potential, rationale: data.open.scoreDetail?.rationale }} fields={[{ name: 'fit', label: 'Fit with label (0-10)', type: 'number', required: true, min: 0, max: 10, step: '0.5' }, { name: 'production', label: 'Production (0-10)', type: 'number', required: true, min: 0, max: 10, step: '0.5' }, { name: 'potential', label: 'Potential (0-10)', type: 'number', required: true, min: 0, max: 10, step: '0.5' }, { name: 'rationale', label: 'Why', type: 'textarea', required: true }]} />
              <ActionButton endpoint={`/catalogue/demos/${data.open.id}`} method="PATCH" body={{ stage: 'shortlisted' }} label="Shortlist" icon="bookmark" block />
              <ActionButton endpoint={`/catalogue/demos/${data.open.id}`} method="PATCH" body={{ stage: 'passed' }} label="Pass" icon="block" block />
              <ActionButton endpoint={`/catalogue/demos/${data.open.id}`} method="PATCH" body={{ stage: 'signed' }} label="Signed" icon="handshake" variant="primary" block />
            </div>
          )}
        </Drawer>
      )}
    </Page>
  );
}
