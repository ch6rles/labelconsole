import type { PageProps } from '@labelconsole/core/web';
import { Cover, DataTable, FilterPills, Icon, Page, PageHeader, Tag, fmt, type Column } from '@labelconsole/ui';
import { FormModal, SearchInput } from '@labelconsole/ui/client';
import * as svc from '../service';
import { EXTRACTION_LABEL, STATUS_LABEL, TYPE_LABEL, uploadFields } from './fields';

type Row = Awaited<ReturnType<typeof svc.listDocuments>>[number];

export default async function DocumentsPage({ run, session, searchParams, path }: PageProps) {
  const type = (['contract', 'statement', 'other'] as const).find((t) => t === searchParams.type);
  const [rows, all] = await run((ctx) => Promise.all([svc.listDocuments(ctx, { type, q: searchParams.q, tag: searchParams.tag }), svc.listDocuments(ctx, {})]));
  const can = (p: string) => session.permissions.has(p);
  const count = (t?: string) => all.filter((d) => !t || d.type === t).length;
  const pill = (label: string, t?: string) => ({ label, count: count(t), href: t ? `${path}?type=${t}` : path, active: type === t });
  const needsReview = all.filter((d) => d.type === 'contract' && d.extractionStatus === 'done' && !d.termsConfirmedAt).length;

  const columns: Column<Row>[] = [
    {
      key: 'title',
      header: 'Document',
      width: 'minmax(260px,1.6fr)',
      render: (d) => (
        <span className="lc-cell-media">
          <Cover icon={d.type === 'contract' ? 'contract' : d.type === 'statement' ? 'receipt_long' : 'description'} />
          <span className="lc-cell-stack">
            <span className="lc-row" style={{ gap: 8, flexWrap: 'nowrap' }}>
              <span className="lc-cell-strong lc-ellipsis">{d.title}</span>
              {d.confidential && <Icon name="lock" size={14} title="Confidential" />}
              {d.version > 1 && <Tag>v{d.version}</Tag>}
            </span>
            <span className="lc-cell-sub lc-ellipsis">{d.parties.length ? d.parties.map((p) => p.name).join(' · ') : d.tags.join(', ') || (d.mime ?? '')}</span>
          </span>
        </span>
      ),
    },
    { key: 'type', header: 'Type', width: '120px', render: (d) => <span style={{ fontSize: 13, color: 'var(--lc-text-2)' }}>{TYPE_LABEL[d.type]}</span> },
    {
      key: 'status',
      header: 'Status',
      width: '170px',
      render: (d) =>
        d.type === 'contract' && d.contractStatus ? (
          <span className={d.contractStatus === 'signed' ? 'lc-chip lc-chip--blue' : d.contractStatus === 'draft' || d.contractStatus === 'expired' ? 'lc-chip lc-chip--red' : 'lc-chip'}>{STATUS_LABEL[d.contractStatus]}</span>
        ) : (
          <span className="lc-muted" style={{ fontSize: 13 }}>—</span>
        ),
    },
    {
      key: 'ai',
      header: 'Terms',
      width: '150px',
      render: (d) =>
        d.type === 'other' ? (
          <span className="lc-muted">—</span>
        ) : d.termsConfirmedAt ? (
          <span className="lc-chip lc-chip--outline-blue">Confirmed</span>
        ) : d.extractionStatus === 'done' && d.type === 'contract' ? (
          <span className="lc-chip lc-chip--ink">Review terms</span>
        ) : d.extractionStatus === 'failed' ? (
          <span className="lc-chip lc-chip--red">Read failed</span>
        ) : (
          <span className="lc-chip">{EXTRACTION_LABEL[d.extractionStatus] ?? d.extractionStatus}</span>
        ),
    },
    { key: 'expiry', header: 'Expires', width: '120px', render: (d) => <span className="lc-mono" style={{ fontSize: 12, color: 'var(--lc-text-2)' }}>{d.expiryDate ? fmt.date(d.expiryDate) : '—'}</span> },
    { key: 'size', header: 'Size', width: '80px', align: 'right', render: (d) => <span className="lc-cell-num lc-muted">{d.size ? fmt.bytes(d.size) : '—'}</span> },
    { key: 'added', header: 'Added', width: '110px', render: (d) => <span className="lc-mono" style={{ fontSize: 12, color: 'var(--lc-muted)' }}>{fmt.shortDate(d.createdAt)}</span> },
  ];

  return (
    <Page>
      <PageHeader
        title="Documents"
        description="Contracts, statements and everything else the label signs or receives. Contracts are read by AI; nothing applies until you confirm the terms."
        actions={
          can('documents:write') && (
            <FormModal
              title="Upload document"
              trigger={{ label: 'Upload', icon: 'upload_file', variant: 'primary' }}
              endpoint="/documents"
              multipart
              fields={uploadFields({ canConfidential: can('documents:read_confidential'), canFinancial: can('documents:read_financial'), type })}
              initial={{ type: type ?? 'contract', contractStatus: 'draft' }}
              redirectTo="/documents/{id}"
              success="Uploaded"
              wide
            />
          )
        }
      />
      <div className="lc-toolbar">
        <FilterPills items={[pill('All'), pill('Contracts', 'contract'), ...(can('documents:read_financial') ? [pill('Statements', 'statement')] : []), pill('Other', 'other')]} />
        <SearchInput placeholder="Search titles and text" />
        <span className="lc-toolbar-end">
          {all.length} documents{needsReview ? ` · ${needsReview} with terms to review` : ''}
        </span>
      </div>
      <DataTable rows={rows} rowKey={(d) => d.id} rowHref={(d) => `/documents/${d.id}`} columns={columns} minWidth={1000} empty={searchParams.q || type ? 'No documents match.' : 'No documents yet. Upload a contract and its terms will be read for you to confirm.'} />
    </Page>
  );
}
