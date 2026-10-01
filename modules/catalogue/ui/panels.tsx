import type { PanelProps } from '@labelconsole/core/web';
import { DataTable, DateTag, fmt } from '@labelconsole/ui';
import * as svc from '../service';
import { STATUS_LABEL, TYPE_LABEL } from './fields';

export async function artistReleasesPanel({ entityId, run }: PanelProps) {
  const rows = await run((ctx) => svc.listReleases(ctx, { artistId: entityId }));
  return (
    <DataTable
      rows={rows}
      rowKey={(r) => r.id}
      rowHref={(r) => `/catalog/releases/${r.id}`}
      minWidth={720}
      empty="No releases linked to this artist yet."
      columns={[
        { key: 't', header: 'Release', width: 'minmax(200px,1fr)', render: (r) => <span className="lc-cell-stack"><span className="lc-cell-strong">{r.title}</span><span className="lc-cell-sub lc-mono">{TYPE_LABEL[r.type]} · {r.upc ? svc.displayUpc(r.upc) : 'No UPC'}</span></span> },
        { key: 's', header: 'Status', width: '120px', render: (r) => <span className="lc-chip">{STATUS_LABEL[r.status]}</span> },
        { key: 'd', header: 'Date', width: '170px', render: (r) => <span className="lc-row" style={{ gap: 8 }}><span className="lc-mono" style={{ fontSize: 12 }}>{r.releaseDate ? fmt.date(r.releaseDate) : '—'}</span><DateTag kind={!r.releaseDate ? 'tbd' : r.upcoming ? 'upcoming' : 'released'}>{!r.releaseDate ? 'TBD' : r.upcoming ? 'Upcoming' : 'Released'}</DateTag></span> },
        { key: 'r', header: 'Readiness', width: '160px', render: (r) => <span className={r.readiness.tone === 'blocked' ? 'lc-chip lc-chip--red' : r.readiness.tone === 'ready' ? 'lc-chip lc-chip--blue' : 'lc-chip'}>{r.readiness.label}</span> },
      ]}
    />
  );
}
