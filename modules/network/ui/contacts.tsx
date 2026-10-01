import type { PageProps } from '@labelconsole/core/web';
import { DataTable, FilterPills, Page, PageHeader, Summary, fmt, type Column } from '@labelconsole/ui';
import { FilterSelect, FormModal, SearchInput } from '@labelconsole/ui/client';
import type { Contact } from '../schema';
import * as svc from '../service';
import { contactFields, STAGE_LABEL, TYPE_LABEL } from './fields';

const ACCOUNT_LABEL = { unverified: 'Not verified', verified: 'Verified', gone: 'Gone', no_payout: 'No payout address' } as const;

export default async function ContactsPage({ run, session, searchParams, path }: PageProps) {
  const type = (['creator', 'editor', 'curator', 'press', 'other'] as const).find((t) => t === searchParams.type);
  const account = (['unverified', 'verified', 'gone', 'no_payout'] as const).find((a) => a === searchParams.account);
  const [rows, counts] = await run((ctx) => Promise.all([svc.listContacts(ctx, { type, account, q: searchParams.q, genre: searchParams.genre }), svc.networkCounts(ctx)]));
  const href = (patch: Record<string, string | undefined>) => {
    const p = new URLSearchParams(Object.entries({ type, account, q: searchParams.q, ...patch }).filter((e): e is [string, string] => Boolean(e[1])));
    return p.size ? `${path}?${p}` : path;
  };

  const columns: Column<Contact>[] = [
    {
      key: 'name',
      header: 'Contact',
      width: 'minmax(220px,1.5fr)',
      render: (c) => (
        <span className="lc-cell-stack">
          <span className="lc-cell-strong lc-ellipsis" style={{ textDecoration: c.goneAt ? 'line-through' : undefined }}>{c.name}</span>
          <span className="lc-cell-sub lc-ellipsis">
            {Object.entries(c.handles).filter(([k]) => k !== 'website').slice(0, 2).map(([k, v]) => `${k} @${v}`).join(' · ') || c.organization || c.email || '—'}
          </span>
        </span>
      ),
    },
    { key: 'type', header: 'Type', width: '130px', render: (c) => <span style={{ fontSize: 13, color: 'var(--lc-text-2)' }}>{TYPE_LABEL[c.type]}</span> },
    { key: 'audience', header: 'Audience', width: '100px', align: 'right', render: (c) => <span className="lc-cell-num">{c.audienceSize != null ? fmt.compact(c.audienceSize) : '—'}</span> },
    { key: 'genres', header: 'Genres', width: 'minmax(140px,1fr)', render: (c) => <span className="lc-cell-sub lc-ellipsis">{c.genres.join(', ') || '—'}</span> },
    { key: 'rate', header: 'Rate', width: '100px', align: 'right', render: (c) => <span className="lc-cell-num">{c.rateCents != null ? fmt.moneyCents(c.rateCents, c.currency, { decimals: 0 }) : '—'}</span> },
    { key: 'stage', header: 'Relationship', width: '130px', render: (c) => <span className={c.stage === 'do_not_contact' ? 'lc-chip lc-chip--red' : c.stage === 'active' ? 'lc-chip lc-chip--blue' : 'lc-chip'}>{STAGE_LABEL[c.stage]}</span> },
    {
      key: 'account',
      header: 'Account',
      width: '130px',
      render: (c) => (c.goneAt ? <span className="lc-chip lc-chip--muted">Gone</span> : c.verifiedAt ? <span className="lc-chip lc-chip--outline-blue">Verified</span> : <span className="lc-chip">Not verified</span>),
    },
    { key: 'last', header: 'Last contact', width: '110px', render: (c) => <span className="lc-mono" style={{ fontSize: 12, color: 'var(--lc-muted)' }}>{c.lastContactedAt ? fmt.relative(c.lastContactedAt) : '—'}</span> },
  ];

  return (
    <Page>
      <PageHeader
        title="Creators"
        description="Creators, playlist editors, curators and press: handles, audience, rates and every conversation the label has had with them."
        actions={session.permissions.has('network:write') && <FormModal title="Add contact" trigger={{ label: 'Add contact', icon: 'person_add', variant: 'primary' }} endpoint="/network/contacts" fields={contactFields} initial={{ type: type ?? 'creator', stage: 'lead', currency: 'USD', handles: {} }} redirectTo="/marketing/contacts/{id}" success="Contact added" wide />}
      />
      <Summary>
        {counts.creators} creators · {counts.total} contacts · {counts.unverifiedCreators} creators not verified · {counts.noPayout} without a payout address
      </Summary>
      <div className="lc-toolbar">
        <FilterPills
          items={[
            { label: 'All', href: href({ type: undefined }), active: !type },
            ...(['creator', 'editor', 'curator', 'press'] as const).map((t) => ({ label: `${TYPE_LABEL[t]}s`, href: href({ type: t }), active: type === t })),
          ]}
        />
        <FilterSelect param="account" allLabel="Any account" options={Object.entries(ACCOUNT_LABEL).map(([value, label]) => ({ value, label }))} />
        <SearchInput placeholder="Name, handle, outlet or email" />
        <span className="lc-toolbar-end">{rows.length} shown</span>
      </div>
      <DataTable rows={rows} rowKey={(c) => c.id} rowHref={(c) => `/marketing/contacts/${c.id}`} columns={columns} minWidth={1080} empty={searchParams.q || type || account ? 'No contacts match.' : 'No contacts yet. Add creators and editors as you work with them, or let an outreach agent research them.'} />
    </Page>
  );
}
