import type { PanelProps } from '@labelconsole/core/web';
import { DataTable, Icon, fmt } from '@labelconsole/ui';
import { UploadZone } from '@labelconsole/ui/client';
import * as svc from '../service';
import { rateLabel, statusChip, TYPE_LABEL } from './fields';

/** Documents linked to a record (artist, release, ...), contributed to its detail page. */
export function documentsPanel(entityType: 'artist' | 'release' | 'track' | 'campaign' | 'contact', defaultType: 'contract' | 'other') {
  return async function DocumentsPanel({ entityId, run, session }: PanelProps) {
    const rows = await run((ctx) => svc.listDocuments(ctx, { entityType, entityId }));
    return (
      <div className="lc-stack">
        {session.permissions.has('documents:write') && <UploadZone endpoint="/documents" extra={{ entityType, entityId, type: defaultType }} compact label={defaultType === 'contract' ? 'Drop a contract to attach it (terms are read for review)' : 'Attach a document'} />}
        <DataTable
          rows={rows}
          rowKey={(d) => d.id}
          rowHref={(d) => `/documents/${d.id}`}
          minWidth={720}
          empty="Nothing linked yet."
          columns={[
            {
              key: 't',
              header: 'Document',
              width: 'minmax(220px,1.4fr)',
              render: (d) => (
                <span className="lc-cell-stack">
                  <span className="lc-row" style={{ gap: 6, flexWrap: 'nowrap' }}>
                    <span className="lc-cell-strong lc-ellipsis">{d.title}</span>
                    {d.confidential && <Icon name="lock" size={14} />}
                  </span>
                  <span className="lc-cell-sub">{d.terms?.agreementType ?? TYPE_LABEL[d.type]}</span>
                </span>
              ),
            },
            { key: 'r', header: 'Royalty', width: '100px', render: (d) => <span className="lc-mono" style={{ fontSize: 12 }}>{d.type === 'contract' ? rateLabel(d.terms) : '—'}</span> },
            {
              key: 's',
              header: 'Status',
              width: '150px',
              render: (d) => {
                if (d.type !== 'contract') return <span className="lc-muted">—</span>;
                const label = svc.contractLabel([{ contractStatus: d.contractStatus, expiryDate: d.expiryDate }]);
                const shown = label === 'None on file' ? 'Unsigned' : label;
                return <span className={statusChip(shown)}>{shown}</span>;
              },
            },
            { key: 'd', header: 'Added', width: '100px', render: (d) => <span className="lc-mono" style={{ fontSize: 12, color: 'var(--lc-muted)' }}>{fmt.shortDate(d.createdAt)}</span> },
          ]}
        />
      </div>
    );
  };
}
