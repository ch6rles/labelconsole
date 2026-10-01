import Link from 'next/link';
import type { PageProps } from '@labelconsole/core/web';
import { DataTable, Icon, Page, PageHeader, fmt } from '@labelconsole/ui';
import { ActionButton, FormModal } from '@labelconsole/ui/client';
import * as svc from '../service';
import { SketchCanvas } from './sketch-canvas';

export async function SketchboardsPage({ run, session }: PageProps) {
  const [rows, campaigns] = await run((ctx) => Promise.all([svc.listSketchboards(ctx), svc.listCampaigns(ctx, {})]));
  return (
    <Page>
      <PageHeader
        title="Sketchboards"
        description="Freeform canvases for planning a rollout: notes, references and timeline milestones."
        actions={session.permissions.has('marketing:write') && <FormModal title="New sketchboard" trigger={{ label: 'New sketchboard', icon: 'add', variant: 'primary' }} endpoint="/marketing/sketchboards" fields={[{ name: 'name', label: 'Name', required: true, full: true }, { name: 'campaignId', label: 'Campaign', type: 'select', options: campaigns.map((c) => ({ value: c.id, label: c.name })) }]} columns={1} redirectTo="/marketing/sketchboards/{id}" success="Sketchboard created" />}
      />
      <DataTable
        rows={rows}
        rowKey={(r) => r.id}
        rowHref={(r) => `/marketing/sketchboards/${r.id}`}
        minWidth={640}
        empty="No sketchboards yet."
        columns={[
          { key: 'n', header: 'Sketchboard', width: 'minmax(220px,1.4fr)', render: (r) => <span className="lc-cell-strong">{r.name}</span> },
          { key: 'c', header: 'Campaign', width: 'minmax(160px,1fr)', render: (r) => <span className="lc-cell-sub">{r.campaignName ?? '—'}</span> },
          { key: 'i', header: 'Items', width: '80px', align: 'right', render: (r) => <span className="lc-cell-num">{r.items}</span> },
          { key: 'u', header: 'Updated', width: '120px', render: (r) => <span className="lc-mono" style={{ fontSize: 12, color: 'var(--lc-muted)' }}>{fmt.relative(r.updatedAt)}</span> },
        ]}
      />
    </Page>
  );
}

export async function SketchboardPage({ run, params, session }: PageProps) {
  const { board, campaignName } = await run((ctx) => svc.getSketchboard(ctx, params.id));
  return (
    <Page>
      <PageHeader
        title={board.name}
        description={campaignName ? <>Sketchboard for <Link href={`/marketing/campaigns/${board.campaignId}`}>{campaignName}</Link>. Drag to move, use the corner to resize.</> : 'Drag to move, use the corner to resize.'}
        actions={session.permissions.has('marketing:delete') && <ActionButton endpoint={`/marketing/sketchboards/${board.id}`} method="DELETE" label="Delete" icon="delete" variant="ghost" confirm={`Delete ${board.name}?`} redirectTo="/marketing/sketchboards" />}
      />
      <SketchCanvas key={`${board.id}-${board.version}`} id={board.id} initialItems={board.canvas.items} initialVersion={board.version} canEdit={session.permissions.has('marketing:write')} />
      <Link href="/marketing/sketchboards" className="lc-btn lc-btn--link"><Icon name="arrow_back" />All sketchboards</Link>
    </Page>
  );
}
