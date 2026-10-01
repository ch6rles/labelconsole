import Link from 'next/link';
import type { PageProps } from '@labelconsole/core/web';
import { listArtists } from '@labelconsole/people/service';
import { Banner, Card, DataTable, Icon, InlineNote, KV, LinkButton, Page, PageHeader, StatCard, Tag, fmt } from '@labelconsole/ui';
import { ActionButton, FormModal, PollUntilDone } from '@labelconsole/ui/client';
import type { ContractTerms, StatementSummary } from '../schema';
import * as svc from '../service';
import { documentFields, EXTRACTION_LABEL, KIND_LABEL, monthYear, rateLabel, STATUS_LABEL, TYPE_LABEL } from './fields';
import { TermsReview } from './terms-review';

export default async function DocumentDetailPage({ run, params, session }: PageProps) {
  const can = (p: string) => session.permissions.has(p);
  const data = await run(async (ctx) => {
    const d = await svc.getDocument(ctx, params.id);
    const [log, artistOptions, lines] = await Promise.all([
      svc.accessLog(ctx, params.id),
      ctx.can('people:read') ? listArtists(ctx).then((a) => a.map((x) => ({ value: x.id, label: x.name }))) : Promise.resolve([] as Array<{ value: string; label: string }>),
      d.document.type === 'statement' ? svc.statementLinesFor(ctx, params.id, 100) : Promise.resolve([] as Awaited<ReturnType<typeof svc.statementLinesFor>>),
    ]);
    return { ...d, log, artistOptions, lines };
  });
  const d = data.document;
  const canWrite = can('documents:write');
  const pending = d.extractionStatus === 'queued' || d.extractionStatus === 'running';
  const fileUrl = `/api/v1/documents/${d.id}/download`;
  const terms = d.terms ?? (d.type === 'contract' ? (d.extractedTerms as ContractTerms | null) : null);
  const summary = d.type === 'statement' ? (d.extractedTerms as StatementSummary | null) : null;

  return (
    <Page>
      {pending && <PollUntilDone endpoint={`/documents/${d.id}/status`} done={['done', 'failed', 'none']} intervalMs={2500} />}
      <PageHeader
        title={
          <span className="lc-row" style={{ gap: 12 }}>
            {d.title}
            {d.confidential && <Icon name="lock" size={22} title="Confidential" />}
          </span>
        }
        description={`${TYPE_LABEL[d.type]} · version ${d.version}${d.isLatest ? '' : ' (superseded)'} · added ${fmt.date(d.createdAt)}${d.size ? ` · ${fmt.bytes(d.size)}` : ''}`}
        actions={
          <>
            {d.fileId && <LinkButton href={`${fileUrl}?inline=1`} icon="visibility" external>Open</LinkButton>}
            {d.fileId && <LinkButton href={fileUrl} icon="download">Download</LinkButton>}
            {canWrite && d.isLatest && (
              <FormModal title="Upload new version" description="The current version is kept in the history. Links and tags carry over." trigger={{ label: 'New version', icon: 'upload_file' }} endpoint={`/documents/${d.id}/versions`} multipart fields={[{ name: 'file', label: 'File', type: 'file', required: true, full: true }]} columns={1} redirectTo="/documents/{id}" success="New version uploaded" />
            )}
            {canWrite && (
              <FormModal title="Edit document" trigger={{ label: 'Edit', icon: 'edit', variant: 'primary' }} endpoint={`/documents/${d.id}`} method="PATCH" fields={documentFields({ canConfidential: can('documents:read_confidential'), contract: d.type === 'contract' })} initial={d as unknown as Record<string, unknown>} />
            )}
          </>
        }
      />

      {!d.isLatest && (
        <Banner icon="history" warn>
          This is an older version. <Link href={`/documents/${data.versions[0].id}`}>Open the current version</Link>.
        </Banner>
      )}
      {d.extractionStatus === 'failed' && !d.termsConfirmedAt && (
        <Banner icon="error" warn>
          Reading this document failed: {(d.extractionError ?? 'unknown error').replace(/\.+$/, '')}.{' '}
          {canWrite && <ActionButton endpoint={`/documents/${d.id}/extract`} label="Try again" size="xs" success="Queued" />}
        </Banner>
      )}

      {d.type === 'contract' && (
        <div className="lc-grid-stats">
          <StatCard label="Status" icon="contract" value={d.contractStatus ? STATUS_LABEL[d.contractStatus] : '—'} note={d.signedAt ? `Signed ${fmt.date(d.signedAt)}` : 'Not signed yet'} />
          <StatCard label="Royalty" icon="percent" value={rateLabel(d.terms)} note={d.terms?.royaltyBasis ?? 'artist / label'} />
          <StatCard label="Term" icon="date_range" value={d.terms?.termDescription ?? '—'} note={d.expiryDate ? `Ends ${fmt.date(d.expiryDate)}` : 'No end date'} />
          <StatCard label="Advance" icon="payments" value={d.terms?.advanceAmount != null ? fmt.money(d.terms.advanceAmount, d.terms.advanceCurrency ?? 'USD') : '—'} note={d.terms?.recoupment ? 'recoupable' : 'none recorded'} />
        </div>
      )}

      {d.type === 'contract' && (
        <Card
          title={d.termsConfirmedAt ? 'Confirmed terms' : 'Review extracted terms'}
          sub={
            d.termsConfirmedAt
              ? `Confirmed ${fmt.date(d.termsConfirmedAt)}. Editing and saving again replaces the key dates.`
              : pending
                ? 'Claude is reading the contract. This page updates when it finishes.'
                : d.extractionStatus === 'done'
                  ? 'Read by AI. Check every field against the document, fix anything wrong, then confirm. Nothing is applied until you do.'
                  : 'Fill the terms in by hand, or have the contract read again.'
          }
          actions={canWrite && !pending && d.fileId && <ActionButton endpoint={`/documents/${d.id}/extract`} label={d.extractionStatus === 'done' ? 'Read again' : 'Read with AI'} icon="auto_awesome" size="sm" success="Queued" />}
        >
          {pending ? (
            <InlineNote icon="hourglass_top">{EXTRACTION_LABEL[d.extractionStatus]}</InlineNote>
          ) : (
            <TermsReview key={`${d.id}-${d.termsConfirmedAt ?? d.extractionStatus}`} documentId={d.id} initial={terms} artistOptions={data.artistOptions} confirmed={Boolean(d.termsConfirmedAt)} disabled={!canWrite} />
          )}
        </Card>
      )}

      {d.type === 'statement' && (
        <>
          {pending && <InlineNote icon="hourglass_top">Parsing the statement…</InlineNote>}
          {summary && (
            <div className="lc-grid-stats">
              <StatCard label="Net" icon="payments" value={fmt.moneyCents(summary.netCents, summary.currency ?? 'USD')} note={summary.distributor ?? 'distributor not detected'} />
              <StatCard label="Gross" icon="account_balance" value={fmt.moneyCents(summary.grossCents, summary.currency ?? 'USD')} note={`${fmt.int(summary.lineCount)} lines`} />
              <StatCard label="Units" icon="graphic_eq" value={fmt.compact(summary.units)} note="streams and downloads" />
              <StatCard label="Period" icon="date_range" value={summary.periodStart ? monthYear(summary.periodStart) : '—'} note={summary.periodEnd ? `through ${fmt.date(summary.periodEnd)}` : ''} />
            </div>
          )}
          {summary?.anomalies.length ? (
            <Card title="Worth a look">
              {summary.anomalies.map((a) => (
                <div key={a} className="lc-kv">
                  <span className="lc-row" style={{ gap: 8 }}>
                    <Icon name="warning" size={16} />
                    {a}
                  </span>
                </div>
              ))}
            </Card>
          ) : null}
          {data.lines.length > 0 && (
            <DataTable
              title="Largest lines"
              rows={data.lines}
              rowKey={(l) => l.id}
              minWidth={860}
              columns={[
                { key: 't', header: 'Track', width: 'minmax(200px,1fr)', render: (l) => <span className="lc-cell-stack"><span className="lc-cell-strong">{l.trackTitle ?? '—'}</span><span className="lc-cell-sub lc-mono">{l.isrc ?? 'no ISRC'}{l.trackId ? '' : ' · unmatched'}</span></span> },
                { key: 's', header: 'Source', width: '140px', render: (l) => l.source },
                { key: 'c', header: 'Territory', width: '90px', render: (l) => <span className="lc-mono">{l.territory ?? '—'}</span> },
                { key: 'u', header: 'Units', width: '100px', align: 'right', render: (l) => <span className="lc-cell-num">{fmt.int(l.units)}</span> },
                { key: 'n', header: 'Net', width: '120px', align: 'right', render: (l) => <span className="lc-cell-num">{fmt.moneyCents(l.netCents, l.currency)}</span> },
              ]}
            />
          )}
        </>
      )}

      <div className="lc-grid-2">
        <Card title="Linked to">
          {data.artists.map((a) => <KV key={a.id} k="Artist" v={<Link href={`/people/artists/${a.id}`}>{a.name}</Link>} />)}
          {data.releases.map((r) => <KV key={r.id} k="Release" v={<Link href={`/catalog/releases/${r.id}`}>{r.title}</Link>} />)}
          {data.links.filter((l) => l.entityType !== 'artist' && l.entityType !== 'release').map((l) => <KV key={l.id} k={fmt.titleCase(l.entityType)} v={<span className="lc-mono">{l.entityId.slice(0, 8)}</span>} />)}
          {data.links.length === 0 && <span className="lc-muted" style={{ fontSize: 13 }}>Not linked yet. Confirming terms links the artists named as parties.</span>}
          {d.tags.length > 0 && <div className="lc-row" style={{ gap: 6, marginTop: 10 }}>{d.tags.map((t) => <Tag key={t}>{t}</Tag>)}</div>}
        </Card>
        <Card title="Key dates" sub="Reminders go to admins 90, 30 and 7 days before.">
          {data.keyDates.length === 0 && <span className="lc-muted" style={{ fontSize: 13 }}>{d.type === 'contract' ? 'Created when terms are confirmed.' : 'None.'}</span>}
          {data.keyDates.map((k) => (
            <KV key={k.id} k={<span className="lc-cell-stack"><span>{KIND_LABEL[k.kind] ?? k.kind}</span><span className="lc-cell-sub">{k.description}</span></span>} v={<span className="lc-mono" style={{ textDecoration: k.dismissedAt ? 'line-through' : undefined }}>{fmt.date(k.date)}</span>} />
          ))}
        </Card>
      </div>

      <div className="lc-grid-2">
        <Card title="Versions">
          {data.versions.map((v) => (
            <KV key={v.id} k={v.id === d.id ? <strong>Version {v.version}</strong> : <Link href={`/documents/${v.id}`}>Version {v.version}</Link>} v={<span className="lc-mono" style={{ fontSize: 12 }}>{fmt.date(v.createdAt)}{v.isLatest ? ' · current' : ''}</span>} />
          ))}
        </Card>
        <Card title="Access log" sub={d.confidential ? 'Every view and download of a confidential document is recorded.' : 'Downloads and previews.'}>
          {data.log.length === 0 && <span className="lc-muted" style={{ fontSize: 13 }}>No access recorded yet.</span>}
          {data.log.slice(0, 12).map((l) => (
            <KV key={l.id} k={<span className="lc-mono" style={{ fontSize: 12 }}>{l.actor.split(':')[0]} · {l.action}</span>} v={<span className="lc-mono" style={{ fontSize: 12 }}>{fmt.relative(l.createdAt)}</span>} />
          ))}
        </Card>
      </div>

      {can('documents:delete') && (
        <div>
          <ActionButton endpoint={`/documents/${d.id}`} method="DELETE" label={d.version > 1 && d.isLatest ? 'Delete this version' : 'Delete document'} icon="delete" variant="ghost" confirm={`Delete "${d.title}" v${d.version}?`} redirectTo="/documents" />
        </div>
      )}
      <Link href="/documents" className="lc-btn lc-btn--link">
        <Icon name="arrow_back" />
        All documents
      </Link>
    </Page>
  );
}
