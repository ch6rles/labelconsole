import Link from 'next/link';
import type { PageProps } from '@labelconsole/core/web';
import { DataTable, Icon, Page, PageHeader, Summary, fmt } from '@labelconsole/ui';
import { ActionButton } from '@labelconsole/ui/client';
import * as svc from '../service';
import { KIND_LABEL } from './fields';

/** Every contract deadline coming up: option windows, notice periods, expiries. */
export default async function KeyDatesPage({ run, session }: PageProps) {
  const rows = await run((ctx) => svc.upcomingKeyDates(ctx, 365));
  const today = new Date().toISOString().slice(0, 10);
  const in30 = new Date(Date.now() + 30 * 86400_000).toISOString().slice(0, 10);
  const canWrite = session.permissions.has('documents:write');

  return (
    <Page>
      <PageHeader title="Key dates" description="Deadlines from confirmed contract terms. Admins are reminded 90, 30 and 7 days before each one." />
      <Summary>
        {rows.filter((r) => r.keyDate.date < today).length} overdue · {rows.filter((r) => r.keyDate.date >= today && r.keyDate.date <= in30).length} in the next 30 days · {rows.length} in the next year
      </Summary>
      <DataTable
        rows={rows}
        rowKey={(r) => r.keyDate.id}
        minWidth={860}
        empty="No upcoming dates. They are created when you confirm a contract's terms."
        columns={[
          {
            key: 'date',
            header: 'Date',
            width: '150px',
            render: (r) => {
              const days = fmt.daysBetween(today, r.keyDate.date);
              return (
                <span className="lc-cell-stack">
                  <span className="lc-mono" style={{ fontSize: 13 }}>{fmt.date(r.keyDate.date)}</span>
                  <span className="lc-cell-sub" style={{ color: r.keyDate.date < today ? 'var(--lc-danger)' : undefined }}>{r.keyDate.date < today ? `${Math.abs(days)} days ago` : days === 0 ? 'today' : `in ${days} days`}</span>
                </span>
              );
            },
          },
          { key: 'kind', header: 'Kind', width: '150px', render: (r) => <span className={r.keyDate.date <= in30 ? 'lc-chip lc-chip--red' : 'lc-chip'}>{KIND_LABEL[r.keyDate.kind] ?? r.keyDate.kind}</span> },
          { key: 'what', header: 'What happens', width: 'minmax(220px,1.4fr)', render: (r) => <span style={{ fontSize: 14 }}>{r.keyDate.description}</span> },
          {
            key: 'doc',
            header: 'Agreement',
            width: 'minmax(180px,1fr)',
            render: (r) => (
              <Link href={`/documents/${r.documentId}`} className="lc-row" style={{ gap: 6, color: 'var(--lc-ink)', flexWrap: 'nowrap' }}>
                {r.confidential && <Icon name="lock" size={14} />}
                <span className="lc-ellipsis">{r.title}</span>
              </Link>
            ),
          },
          {
            key: 'actions',
            header: '',
            width: '60px',
            align: 'right',
            render: (r) => (canWrite ? <ActionButton iconOnly icon="done" title="Mark handled" endpoint={`/documents-key-dates/${r.keyDate.id}/dismiss`} success="Marked as handled" /> : null),
          },
        ]}
      />
    </Page>
  );
}
