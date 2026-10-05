import Link from 'next/link';
import type { PageProps } from '@labelconsole/core/web';
import { BarChart, Card, DataTable, EmptyState, Legend, LinkButton, Page, PageHeader, ShareBars, StatCard, Summary, fmt } from '@labelconsole/ui';
import { FormModal } from '@labelconsole/ui/client';
import * as svc from '../service';
import { monthYear } from './fields';

/** Finance → Royalties: booked revenue for the current period, split the way the contracts say. */
export default async function RoyaltiesPage({ run, session }: PageProps) {
  const [r, latest] = await run((ctx) => Promise.all([svc.royalties(ctx, 12), svc.latestStatementSummary(ctx)]));
  const currency = (session.org.settings as { currency?: string }).currency ?? 'USD';
  const money = (cents: number | null) => (cents == null ? '—' : fmt.moneyCents(cents, currency));
  const periodLabel = r.period ? monthYear(r.period) : null;
  const distributor = latest?.summary?.distributor ?? (session.org.settings as { distributor?: string }).distributor ?? 'Distributor';

  // Twelve month slots ending this month, so gaps show as zero rather than disappearing.
  const now = new Date();
  const slots = Array.from({ length: 12 }, (_, i) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 11 + i, 1)).toISOString().slice(0, 7));
  const bars = slots.map((m) => ({ label: fmt.monthLabel(`${m}-01`), value: (r.byMonth.find((b) => b.month === m)?.netCents ?? 0) / 100 }));
  const totalSource = r.bySource.reduce((a, s) => a + s.netCents, 0) || 1;
  const hasData = r.byMonth.length > 0;

  const importButton = session.permissions.has('documents:write') && (
    <FormModal
      title="Import distributor report"
      description="Upload your distributor's statement as .xlsx, CSV or PDF. Lines are matched to the catalogue by ISRC and UPC."
      trigger={{ label: 'Import report', icon: 'upload', variant: 'primary' }}
      endpoint="/documents"
      multipart
      extra={{ type: 'statement' }}
      fields={[
        { name: 'file', label: 'Statement file', type: 'file', required: true, full: true, accept: '.xlsx,.csv,.tsv,.txt,.pdf', hint: 'Use the detailed (line-by-line) report, not the summary: it has a row for each track, store and country.' },
        { name: 'title', label: 'Title', placeholder: 'e.g. DistroKid Jul 2026', full: true },
      ]}
      columns={1}
      redirectTo="/documents/{id}"
      success="Report uploaded. Parsing now."
    />
  );

  return (
    <Page>
      <PageHeader
        title="Royalties"
        description="Booked revenue for the current period, split the way the contracts say."
        actions={
          <>
            {hasData && <LinkButton href="/api/v1/finance/royalties/export" icon="download">Export CSV</LinkButton>}
            {importButton}
          </>
        }
      />
      {!hasData ? (
        <EmptyState icon="account_balance_wallet" title="No statements imported yet" action={importButton}>
          Import a distributor report and booked revenue, sources and top releases appear here. Artist and label shares come from confirmed contract terms.
        </EmptyState>
      ) : (
        <>
          <Summary>
            Period {periodLabel} · booked through {r.bookedThrough ?? '—'} · {distributor} report imported {latest ? fmt.shortDate(latest.document.createdAt) : '—'}
          </Summary>
          <div className="lc-grid-stats">
            <StatCard label="GROSS BOOKED" icon="payments" value={money(r.totals.grossCents || r.totals.netCents)} note={`${periodLabel} · all sources`} />
            <StatCard label="ARTIST SHARE" icon="person" value={money(r.totals.artistShareCents)} note="before recoupment" />
            <StatCard label="LABEL SHARE" icon="account_balance" value={money(r.totals.labelShareCents)} note="after distribution fee" />
            <StatCard
              label="NOT YET SPLIT"
              icon="rule"
              value={money(r.totals.uncoveredCents)}
              note={r.totals.unmatchedCents ? `${money(r.totals.unmatchedCents)} not matched to the catalogue` : r.totals.uncoveredCents ? 'releases without confirmed terms' : 'every release has confirmed terms'}
            />
          </div>
          <div className="lc-grid-2">
            <Card title="Booked revenue · 12 months" actions={<Legend items={[{ label: 'Booked' }]} />}>
              <BarChart data={bars} format={(v) => (v >= 1000 ? `${(v / 1000).toFixed(v >= 10000 ? 0 : 1)}k` : String(Math.round(v)))} />
            </Card>
            <Card title={`By source · ${periodLabel}`}>
              <ShareBars rows={r.bySource.map((s) => ({ name: s.source, value: money(s.netCents), pct: (s.netCents / totalSource) * 100 }))} />
            </Card>
          </div>
          <DataTable
            title="Top earning releases"
            rows={r.top}
            rowKey={(t) => t.releaseId ?? 'unmatched'}
            minWidth={820}
            columns={[
              { key: 'title', header: 'Release', width: 'minmax(200px,1.4fr)', render: (t) => (t.releaseId ? <Link href={`/catalog/releases/${t.releaseId}`} className="lc-cell-strong" style={{ color: 'var(--lc-ink)' }}>{t.title}</Link> : <span className="lc-cell-strong lc-muted">{t.title}</span>) },
              { key: 'artist', header: 'Artist', width: 'minmax(140px,1fr)', render: (t) => <span style={{ color: 'var(--lc-text-2)' }}>{t.artist}</span> },
              { key: 'units', header: 'Streams', width: '110px', align: 'right', render: (t) => <span className="lc-cell-num">{fmt.compact(t.units)}</span> },
              { key: 'gross', header: 'Gross', width: '130px', align: 'right', render: (t) => <span className="lc-cell-num">{money(t.grossCents || t.netCents)}</span> },
              { key: 'artistShare', header: 'Artist share', width: '130px', align: 'right', render: (t) => <span className="lc-cell-num" title={t.artistShareCents == null ? 'No confirmed contract terms for this artist' : undefined}>{money(t.artistShareCents)}</span> },
              { key: 'labelShare', header: 'Label share', width: '130px', align: 'right', render: (t) => <span className="lc-cell-num" style={{ color: 'var(--lc-accent-hover)' }}>{money(t.labelShareCents)}</span> },
            ]}
          />
        </>
      )}
    </Page>
  );
}
