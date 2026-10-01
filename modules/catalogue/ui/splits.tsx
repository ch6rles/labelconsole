import Link from 'next/link';
import type { PageProps } from '@labelconsole/core/web';
import { Chip, DataTable, Page, PageHeader, SplitBar, Summary, fmt } from '@labelconsole/ui';
import * as svc from '../service';

const TONE: Record<string, 'red' | 'neutral' | 'blue'> = { draft: 'red', sent: 'red', partly_signed: 'neutral', signed: 'blue' };
const LABEL: Record<string, string> = { draft: 'Unsigned', sent: 'Unsigned', partly_signed: 'Partly signed', signed: 'Signed' };

export default async function SplitsPage({ run }: PageProps) {
  const sheets = await run((ctx) => svc.listSplitSheets(ctx));
  const open = sheets.filter((s) => s.status !== 'signed');
  const oldest = open.filter((s) => s.sentAt).sort((a, b) => a.sentAt!.getTime() - b.sentAt!.getTime())[0];
  return (
    <Page>
      <PageHeader title="Splits" description="Who owns what on each track. Unsigned sheets hold back payment on that track." />
      <Summary>
        {sheets.length} split sheets · {open.length} not fully signed{oldest ? ` · oldest waiting ${fmt.daysBetween(oldest.sentAt!)} days` : ''}
      </Summary>
      <DataTable
        rows={sheets}
        rowKey={(s) => s.id}
        rowHref={(s) => `/catalog/tracks/${s.trackId}`}
        minWidth={1040}
        gap={16}
        empty={<span>No split sheets yet. Open a track and create one; tracks without a signed sheet stay blocked. <Link href="/catalog/tracks">All tracks</Link></span>}
        columns={[
          { key: 'track', header: 'Track', width: 'minmax(150px,0.9fr)', render: (s) => <span className="lc-cell-strong">{s.trackTitle}</span> },
          { key: 'release', header: 'Release', width: 'minmax(140px,0.8fr)', render: (s) => <span style={{ fontSize: 13, color: 'var(--lc-text-2)' }}>{s.releaseTitle ?? '—'}</span> },
          { key: 'shares', header: 'Shares', width: 'minmax(300px,1.8fr)', render: (s) => <SplitBar parts={s.parties.map((p) => ({ name: p.name, pct: Number(p.sharePct) }))} /> },
          { key: 'signed', header: 'Signed', width: '110px', render: (s) => <span className="lc-mono" style={{ fontSize: 13 }}>{s.parties.filter((p) => p.signedAt).length} of {s.parties.length}</span> },
          { key: 'status', header: 'Status', width: '150px', render: (s) => <Chip tone={TONE[s.status]}>{LABEL[s.status] ?? s.status}</Chip> },
          { key: 'waiting', header: 'Waiting', width: '80px', align: 'right', render: (s) => <span className="lc-mono" style={{ fontSize: 13, color: s.status !== 'signed' ? 'var(--lc-danger-fg)' : 'var(--lc-muted)' }}>{s.status !== 'signed' && s.sentAt ? `${fmt.daysBetween(s.sentAt)} days` : '—'}</span> },
        ]}
      />
    </Page>
  );
}
