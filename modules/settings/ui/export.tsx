import { storage } from '@labelconsole/core/storage';
import type { PageProps } from '@labelconsole/core/web';
import { Card, Chip, DataTable, Page, PageHeader, fmt } from '@labelconsole/ui';
import { ActionButton, PollUntilDone } from '@labelconsole/ui/client';
import * as svc from '../service';
import { DeleteLabel } from './client';

export default async function ExportPage({ run, session }: PageProps) {
  const rows = await run((ctx) => svc.listExports(ctx));
  const withUrls = await Promise.all(rows.map(async (r) => ({ ...r, url: r.status === 'done' && r.storageKey ? await storage().signedUrl(r.storageKey, { expiresInSec: 600, filename: `label-export-${fmt.shortDate(r.createdAt).replace(' ', '-')}.ndjson` }) : null })));
  const pending = rows.find((r) => r.status === 'queued' || r.status === 'running');
  return (
    <Page variant="narrow">
      <PageHeader title="Data export" description="Download everything this label owns as newline-delimited JSON, one row per line, built in the background." actions={<ActionButton endpoint="/settings/exports" label="Export all data" icon="download" variant="primary" success="Export started" />} />
      {pending && <PollUntilDone endpoint={`/settings/exports/${pending.id}`} done={['done', 'failed']} />}
      <DataTable
        rows={withUrls}
        rowKey={(r) => r.id}
        minWidth={640}
        empty="No exports yet."
        columns={[
          { key: 'when', header: 'Requested', width: 'minmax(160px,1fr)', render: (r) => <span>{fmt.date(r.createdAt)} · {fmt.time(r.createdAt)} UTC</span> },
          { key: 'status', header: 'Status', width: '120px', render: (r) => <Chip tone={r.status === 'done' ? 'blue' : r.status === 'failed' ? 'red' : 'neutral'}>{fmt.titleCase(r.status)}</Chip> },
          { key: 'size', header: 'Size', width: '100px', align: 'right', render: (r) => <span className="lc-cell-num">{fmt.bytes(r.size)}</span> },
          { key: 'dl', header: '', width: '120px', align: 'right', render: (r) => (r.url ? <a href={r.url}>Download</a> : r.error ? <span className="lc-danger-text" title={r.error}>Failed</span> : '—') },
        ]}
      />
      {session.permissions.has('settings:billing') && (
        <Card title="Delete label" sub="Removes every record and file this label owns. This cannot be undone.">
          <DeleteLabel name={session.org.name} />
        </Card>
      )}
    </Page>
  );
}
