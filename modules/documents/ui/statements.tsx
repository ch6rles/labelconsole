import type { PageProps } from '@labelconsole/core/web';
import { DataTable, Icon, Page, PageHeader, Summary, fmt, type Column } from '@labelconsole/ui';
import { FormModal } from '@labelconsole/ui/client';
import type { Document, StatementSummary } from '../schema';
import * as svc from '../service';
import { EXTRACTION_LABEL, monthYear } from './fields';

type Row = Document & { summary: StatementSummary | null };

/** Finance → Statements: distributor reports imported into the label's books. */
export default async function StatementsPage({ run, session }: PageProps) {
  const docs = await run((ctx) => svc.listStatements(ctx));
  const rows: Row[] = docs.map((d) => ({ ...d, summary: d.extractionStatus === 'done' ? (d.extractedTerms as StatementSummary | null) : null }));
  const parsed = rows.filter((r) => r.summary);
  const totalNet = parsed.reduce((a, r) => a + (r.summary?.netCents ?? 0), 0);
  const flagged = parsed.filter((r) => r.summary?.anomalies.length).length;
  const currency = (session.org.settings as { currency?: string }).currency ?? 'USD';

  const columns: Column<Row>[] = [
    {
      key: 'title',
      header: 'Statement',
      width: 'minmax(220px,1.4fr)',
      render: (r) => (
        <span className="lc-cell-stack">
          <span className="lc-cell-strong">{r.title}</span>
          <span className="lc-cell-sub">{r.summary?.distributor ?? 'Distributor not detected'}</span>
        </span>
      ),
    },
    { key: 'period', header: 'Period', width: '120px', render: (r) => <span className="lc-mono" style={{ fontSize: 12 }}>{r.summary?.periodStart ? monthYear(r.summary.periodStart) : '—'}</span> },
    { key: 'lines', header: 'Lines', width: '90px', align: 'right', render: (r) => <span className="lc-cell-num">{r.summary ? fmt.int(r.summary.lineCount) : '—'}</span> },
    { key: 'units', header: 'Units', width: '100px', align: 'right', render: (r) => <span className="lc-cell-num">{r.summary ? fmt.compact(r.summary.units) : '—'}</span> },
    { key: 'net', header: 'Net', width: '130px', align: 'right', render: (r) => <span className="lc-cell-num" style={{ fontWeight: 500 }}>{r.summary ? fmt.moneyCents(r.summary.netCents, r.summary.currency ?? currency) : '—'}</span> },
    {
      key: 'checks',
      header: 'Checks',
      width: 'minmax(200px,1fr)',
      render: (r) =>
        r.extractionStatus === 'failed' ? (
          <span className="lc-chip lc-chip--red" title={r.extractionError ?? ''}>Could not parse</span>
        ) : !r.summary ? (
          <span className="lc-chip">{EXTRACTION_LABEL[r.extractionStatus] ?? r.extractionStatus}</span>
        ) : r.summary.anomalies.length ? (
          <span className="lc-row" style={{ gap: 6, flexWrap: 'nowrap', fontSize: 13 }} title={r.summary.anomalies.join('\n')}>
            <Icon name="warning" size={16} />
            <span className="lc-ellipsis">{r.summary.anomalies[0]}{r.summary.anomalies.length > 1 ? ` (+${r.summary.anomalies.length - 1})` : ''}</span>
          </span>
        ) : (
          <span className="lc-chip lc-chip--outline-blue">No issues</span>
        ),
    },
    { key: 'added', header: 'Imported', width: '100px', render: (r) => <span className="lc-mono" style={{ fontSize: 12, color: 'var(--lc-muted)' }}>{fmt.shortDate(r.createdAt)}</span> },
  ];

  return (
    <Page>
      <PageHeader
        title="Statements"
        description="Distributor reports imported into the label's books. Each one is matched to the catalogue by ISRC and UPC and checked against the previous period."
        actions={
          session.permissions.has('documents:write') && (
            <FormModal
              title="Import distributor report"
              trigger={{ label: 'Import report', icon: 'upload', variant: 'primary' }}
              endpoint="/documents"
              multipart
              extra={{ type: 'statement' }}
              fields={[
                { name: 'file', label: 'Statement file', type: 'file', required: true, full: true, accept: '.csv,.tsv,.txt,.pdf' },
                { name: 'title', label: 'Title', placeholder: 'e.g. DistroKid Jul 2026', full: true },
              ]}
              columns={1}
              redirectTo="/documents/{id}"
              success="Report uploaded. Parsing now."
            />
          )
        }
      />
      <Summary>
        {rows.length} reports · {fmt.moneyCents(totalNet, currency)} net across parsed reports · {flagged} flagged for a look
      </Summary>
      <DataTable rows={rows} rowKey={(r) => r.id} rowHref={(r) => `/documents/${r.id}`} columns={columns} minWidth={960} empty="No statements yet. Import your distributor's monthly report." />
    </Page>
  );
}
