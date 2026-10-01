import Link from 'next/link';
import { listArtists } from '@labelconsole/people/service';
import type { PageProps } from '@labelconsole/core/web';
import { DataTable, FilterPills, Page, PageHeader, Summary, fmt, type Column } from '@labelconsole/ui';
import { FormModal } from '@labelconsole/ui/client';
import * as svc from '../service';
import { monthYear, rateLabel, statusChip, uploadFields } from './fields';

type Row = {
  id: string;
  artistId: string | null;
  artist: string;
  title: string;
  covers: string | null;
  type: string;
  term: string;
  rate: string;
  status: string;
  date: string;
  sort: number;
};

const ORDER = ['Expiring', 'Unsigned', 'Sent · awaiting', 'Expired', 'Signed', 'Terminated'];

/** People → Contracts: every agreement, the artist it is with, and what it covers. */
export default async function ContractsPage({ run, session, searchParams, path }: PageProps) {
  const can = (p: string) => session.permissions.has(p);
  const { docs, artistNames } = await run(async (ctx) => {
    const docs = await svc.listDocuments(ctx, { type: 'contract' });
    const artistNames = ctx.can('people:read') ? new Map((await listArtists(ctx)).map((a) => [a.id, a.name])) : new Map<string, string>();
    return { docs, artistNames };
  });
  const today = new Date().toISOString().slice(0, 10);
  const soon = new Date(Date.now() + 90 * 86400_000).toISOString().slice(0, 10);

  const rows: Row[] = docs.flatMap((d): Row[] => {
    const label = svc.contractLabel([{ contractStatus: d.contractStatus, expiryDate: d.expiryDate }]);
    const status = label === 'None on file' ? 'Unsigned' : label.startsWith('Expiring') ? 'Expiring' : label === 'Sent' ? 'Sent · awaiting' : d.contractStatus === 'terminated' ? 'Terminated' : label;
    const terms = d.terms ?? null;
    const covers = !terms ? null : terms.releasesCovered.length === 1 ? terms.releasesCovered[0] : terms.releasesCovered.length ? `${terms.releasesCovered.length} releases` : 'no releases listed';
    const date =
      status === 'Expiring' && d.expiryDate
        ? fmt.date(d.expiryDate)
        : d.signedAt
          ? `Signed ${fmt.date(d.signedAt)}`
          : status === 'Sent · awaiting'
            ? `Sent ${fmt.shortDate(d.createdAt)}`
            : `Drafted ${fmt.shortDate(d.createdAt)}`;
    const artistLinks = d.links.filter((l) => l.entityType === 'artist');
    const base = {
      id: d.id,
      title: d.title,
      covers,
      type: terms?.agreementType ?? '—',
      // The design shows the end month only when it matters: on expiring contracts.
      term: [terms?.termDescription, status === 'Expiring' || !terms?.termDescription ? (d.expiryDate ? `ends ${monthYear(d.expiryDate)}` : null) : null].filter(Boolean).join(' · ') || '—',
      rate: rateLabel(terms),
      status,
      date,
      sort: ORDER.indexOf(status),
    };
    if (artistLinks.length === 0) return [{ ...base, artistId: null, artist: d.parties.find((p) => p.role.toLowerCase().includes('artist'))?.name ?? '—' }];
    return artistLinks.map((l) => ({ ...base, artistId: l.entityId, artist: artistNames.get(l.entityId) ?? '—' }));
  });
  rows.sort((a, b) => a.sort - b.sort || a.artist.localeCompare(b.artist));

  const filter = searchParams.status;
  const shown = filter ? rows.filter((r) => r.status === filter) : rows;
  const n = (s: string) => rows.filter((r) => r.status === s).length;
  const expiring90 = docs.filter((d) => d.contractStatus === 'signed' && d.expiryDate && d.expiryDate >= today && d.expiryDate <= soon).length;

  const columns: Column<Row>[] = [
    { key: 'artist', header: 'Artist', width: 'minmax(150px,1fr)', render: (r) => (r.artistId ? <Link href={`/people/artists/${r.artistId}`} className="lc-cell-strong" style={{ color: 'var(--lc-ink)' }}>{r.artist}</Link> : <span className="lc-cell-strong">{r.artist}</span>) },
    {
      key: 'agreement',
      header: 'Agreement',
      width: 'minmax(220px,1.4fr)',
      render: (r) => (
        <span className="lc-cell-stack">
          <Link href={`/documents/${r.id}`} style={{ fontSize: 14, color: 'var(--lc-ink)' }}>{r.title}</Link>
          <span className="lc-cell-sub">{r.covers ? `Covers ${r.covers}` : 'Terms not confirmed yet'}</span>
        </span>
      ),
    },
    { key: 'type', header: 'Type', width: '170px', render: (r) => <span style={{ fontSize: 13, color: 'var(--lc-text-2)' }}>{r.type}</span> },
    { key: 'term', header: 'Term', width: '120px', render: (r) => <span className="lc-mono" style={{ fontSize: 12, color: 'var(--lc-text-2)' }}>{r.term}</span> },
    { key: 'rate', header: 'Royalty', width: '110px', render: (r) => <span className="lc-mono" style={{ fontSize: 12, color: 'var(--lc-text-2)' }}>{r.rate}</span> },
    { key: 'status', header: 'Status', width: '150px', render: (r) => <span className={statusChip(r.status)}>{r.status}</span> },
    { key: 'date', header: 'Date', width: '120px', render: (r) => <span className="lc-mono" style={{ fontSize: 12, color: 'var(--lc-muted)' }}>{r.date}</span> },
  ];

  return (
    <Page>
      <PageHeader
        title="Contracts"
        description="Every agreement the label holds, and the releases each one covers."
        actions={
          can('documents:write') && (
            <FormModal title="Upload contract" trigger={{ label: 'Upload contract', icon: 'upload_file', variant: 'primary' }} endpoint="/documents" multipart fields={uploadFields({ canConfidential: can('documents:read_confidential'), canFinancial: false }).filter((f) => f.name !== 'type')} extra={{ type: 'contract' }} initial={{ contractStatus: 'draft' }} redirectTo="/documents/{id}" success="Uploaded. Claude is reading the terms." wide />
          )
        }
      />
      <Summary>
        {docs.length} agreements · {expiring90} expiring within 90 days · {n('Sent · awaiting')} sent, awaiting signature · {n('Unsigned')} unsigned
      </Summary>
      <FilterPills items={[{ label: 'All', count: rows.length, href: path, active: !filter }, ...ORDER.filter((s) => n(s) > 0).map((s) => ({ label: s, count: n(s), href: `${path}?status=${encodeURIComponent(s)}`, active: filter === s }))]} />
      <DataTable rows={shown} rowKey={(r) => `${r.id}-${r.artistId ?? ''}`} columns={columns} minWidth={1040} empty="No contracts on file. Upload one and its terms are read for you to confirm." />
    </Page>
  );
}
