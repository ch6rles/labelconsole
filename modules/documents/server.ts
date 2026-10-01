import './types';
import { and, eq, ilike, ne, or, sql } from 'drizzle-orm';
import { defineModule } from '@labelconsole/core/modules';
import { fmt } from '@labelconsole/ui';
import { tools } from './agent-tools';
import { routes } from './api';
import { jobs } from './jobs';
import { manifest } from './manifest';
import { documents } from './schema';
import * as svc from './service';

export default defineModule({
  manifest,
  routes,
  onboarding: async (ctx) => {
    const [r] = await ctx.tx.select({ n: sql<number>`count(*)::int` }).from(documents);
    return [{ id: 'documents', title: 'Upload a contract or a distributor statement', sub: 'Contract terms are read for you to confirm; statements fill in royalties', done: (r?.n ?? 0) > 0, href: '/documents', order: 50 }];
  },
  jobs,
  tools,
  schedules: [{ id: 'documents-reminders', job: 'documents.reminders', cron: '0 7 * * *' }],
  widgets: [
    {
      id: 'statements',
      name: 'Statements',
      icon: 'receipt_long',
      desc: 'The latest imported royalty statement',
      permission: 'documents:read_financial',
      load: async (ctx) => {
        const s = await svc.latestStatementSummary(ctx);
        if (!s?.summary) return { value: '—', unit: 'no statement yet', line: 'Import a distributor statement to see revenue', cta: 'Open statements', href: '/finance/statements' };
        return { value: fmt.moneyCents(s.summary.netCents, s.summary.currency ?? 'USD', { decimals: 0 }), unit: 'net', line: `${s.summary.periodEnd ? `Through ${fmt.shortDate(s.summary.periodEnd)}` : s.document.title} · ${s.summary.lineCount} lines${s.summary.anomalies.length ? ` · ${s.summary.anomalies.length} to check` : ''}`, cta: 'Open statements', href: '/finance/statements' };
      },
    },
    {
      id: 'contracts',
      name: 'Contracts',
      icon: 'draft',
      desc: 'Live releases missing signed paper',
      permission: 'documents:read',
      load: async (ctx) => {
        const list = await svc.liveReleasesOnUnsignedPaper(ctx);
        const artists = [...new Set(list.map((l) => l.artistName))];
        return { value: String(list.length), unit: 'unsigned live', line: artists.length ? `${artists.slice(0, 2).join(', ')}${artists.length > 2 ? ` +${artists.length - 2}` : ''}` : 'Every live release has signed paper', cta: 'Open contracts', href: '/people/contracts' };
      },
    },
  ],
  stats: async (ctx) => {
    if (!ctx.can('documents:read_financial')) return [];
    const r = await svc.royalties(ctx, 12);
    if (!r.period) return [{ label: 'REVENUE · BOOKED', icon: 'payments', value: '—', note: 'import a distributor statement', group: 'health' }];
    const prev = r.byMonth.at(-2);
    const change = prev && prev.netCents > 0 ? ((r.totals.netCents - prev.netCents) / prev.netCents) * 100 : null;
    return [
      {
        label: 'REVENUE · BOOKED',
        icon: 'payments',
        value: fmt.moneyCents(r.totals.netCents),
        delta: change != null ? fmt.pct(change, { signed: true, decimals: 1 }) : undefined,
        note: `${r.period} · booked through ${r.bookedThrough ?? '—'}`,
        group: 'health',
      },
    ];
  },
  attention: async (ctx) => {
    if (!ctx.can('documents:read')) return [];
    const [unsigned, dates, contracts] = await Promise.all([svc.liveReleasesOnUnsignedPaper(ctx), svc.upcomingKeyDates(ctx, 30), svc.listDocuments(ctx, { type: 'contract' })]);
    const awaiting = contracts.filter((d) => d.extractionStatus === 'done' && !d.termsConfirmedAt);
    return [
      { n: unsigned.length, tone: 'red', title: 'Live releases on unsigned paper', sub: [...new Set(unsigned.map((u) => u.artistName))].slice(0, 3).join(', '), href: '/people/contracts' },
      { n: dates.filter((d) => d.keyDate.date >= new Date().toISOString().slice(0, 10)).length, tone: 'ink', title: 'Contract dates in the next 30 days', sub: dates.slice(0, 2).map((d) => `${d.title}: ${d.keyDate.kind} ${fmt.shortDate(d.keyDate.date)}`).join(' · '), href: '/documents/key-dates' },
      { n: awaiting.length, tone: 'ink', title: 'Extracted contract terms to confirm', sub: 'AI-extracted terms only apply after a person confirms them', href: '/people/contracts' },
    ];
  },
  search: async (ctx, q) => {
    if (!ctx.can('documents:read')) return [];
    const conds = [eq(documents.isLatest, true), or(ilike(documents.title, `%${q}%`), ilike(documents.textContent, `%${q}%`))];
    if (!ctx.can('documents:read_confidential')) conds.push(eq(documents.confidential, false));
    if (!ctx.can('documents:read_financial')) conds.push(ne(documents.type, 'statement'));
    const rows = await ctx.tx.select({ id: documents.id, title: documents.title, type: documents.type }).from(documents).where(and(...conds)).limit(6);
    return rows.filter((r) => r.type !== 'statement' || ctx.can('documents:read_financial')).map((r) => ({ type: 'Document', title: r.title, sub: `Document · ${r.type}`, href: `/documents/${r.id}`, icon: 'description' }));
  },
  enrich: {
    artist: async (ctx, ids) => {
      if (!ctx.can('documents:read')) return {};
      const [contracts, earnings] = await Promise.all([svc.contractsForArtists(ctx, ids), svc.earningsByArtist(ctx, ids)]);
      return Object.fromEntries(
        ids.map((id) => {
          const mine = contracts.filter((c) => c.artistId === id);
          const best = mine.find((c) => c.contractStatus === 'signed' && c.terms) ?? mine.find((c) => c.terms) ?? mine[0];
          const t = best?.terms;
          return [
            id,
            {
              contract: svc.contractLabel(mine),
              contractDocumentId: best?.id ?? null,
              deal: t?.agreementType ?? best?.title ?? null,
              split: t?.royaltyArtistPct != null ? `${t.royaltyArtistPct} / ${t.royaltyLabelPct ?? 100 - t.royaltyArtistPct} ${t.royaltyBasis ?? ''}`.trim() : null,
              advance: t?.advanceAmount != null ? fmt.money(t.advanceAmount, t.advanceCurrency ?? 'USD', { decimals: 0 }) : t ? 'None' : null,
              earned12mCents: Number(earnings.find((e) => e.artistId === id)?.net ?? 0) || null,
            },
          ];
        }),
      );
    },
  },
});
