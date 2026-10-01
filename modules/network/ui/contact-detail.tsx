import Link from 'next/link';
import type { PageProps } from '@labelconsole/core/web';
import { Banner, Card, Icon, KV, Page, PageHeader, StatCard, Tag, Timeline, fmt } from '@labelconsole/ui';
import { ActionButton, FormModal } from '@labelconsole/ui/client';
import * as svc from '../service';
import { contactFields, handleUrl, STAGE_LABEL, TYPE_LABEL } from './fields';

const CHANNEL_ICON: Record<string, string> = { email: 'mail', dm: 'chat', call: 'call', meeting: 'groups', note: 'sticky_note_2' };

export default async function ContactDetailPage({ run, params, session, panels }: PageProps) {
  const d = await run((ctx) => svc.getContact(ctx, params.id));
  const c = d.contact;
  const canWrite = session.permissions.has('network:write');
  const rendered = await Promise.all(panels('contact').map(async (p) => ({ id: p.id, title: p.title, node: await p.component({ entityId: c.id, run, session }) })));

  return (
    <Page>
      <PageHeader
        title={
          <span className="lc-row" style={{ gap: 12 }}>
            {c.name}
            <Tag>{TYPE_LABEL[c.type]}</Tag>
          </span>
        }
        description={[c.organization, c.country, c.email].filter(Boolean).join(' · ') || 'No contact details yet'}
        actions={
          canWrite && (
            <>
              {!c.goneAt && !c.verifiedAt && <ActionButton endpoint={`/network/contacts/${c.id}/account`} body={{ state: 'verified' }} label="Mark verified" icon="verified" success="Account verified" />}
              {!c.goneAt && <ActionButton endpoint={`/network/contacts/${c.id}/account`} body={{ state: 'gone' }} label="Account gone" icon="person_off" variant="ghost" confirm={`Mark ${c.name}'s account as gone? Past bookings stay on record.`} />}
              {c.goneAt && <ActionButton endpoint={`/network/contacts/${c.id}/account`} body={{ state: 'unverified' }} label="Account is back" icon="undo" variant="ghost" />}
              <FormModal title={`Log a conversation with ${c.name}`} trigger={{ label: 'Log interaction', icon: 'add_comment' }} endpoint={`/network/contacts/${c.id}/interactions`} fields={[{ name: 'channel', label: 'Channel', type: 'select', required: true, options: svc.INTERACTION_CHANNELS.map((x) => ({ value: x, label: fmt.titleCase(x) })) }, { name: 'direction', label: 'Direction', type: 'select', required: true, options: [{ value: 'outbound', label: 'We reached out' }, { value: 'inbound', label: 'They reached out' }] }, { name: 'summary', label: 'What was said', type: 'textarea', required: true }]} initial={{ channel: 'email', direction: 'outbound' }} success="Logged" />
              <FormModal title={`Edit ${c.name}`} trigger={{ label: 'Edit', icon: 'edit', variant: 'primary' }} endpoint={`/network/contacts/${c.id}`} method="PATCH" fields={contactFields} initial={c as unknown as Record<string, unknown>} wide />
            </>
          )
        }
      />
      {c.goneAt && <Banner icon="person_off" warn>This account no longer exists (marked {fmt.date(c.goneAt)}). It stays visible so past spend is auditable. Don&apos;t book it again.</Banner>}
      {c.stage === 'do_not_contact' && <Banner icon="block" warn>{c.name} asked not to be contacted. Outreach to them is blocked.</Banner>}
      <div className="lc-grid-stats">
        <StatCard label="AUDIENCE" icon="group" value={c.audienceSize != null ? fmt.compact(c.audienceSize) : '—'} note={c.genres.join(', ') || 'no genres set'} />
        <StatCard label="RATE" icon="payments" value={c.rateCents != null ? fmt.moneyCents(c.rateCents, c.currency) : '—'} note="typical, per post or placement" />
        <StatCard label="RELATIONSHIP" icon="handshake" value={STAGE_LABEL[c.stage]} note={c.lastContactedAt ? `last contact ${fmt.relative(c.lastContactedAt)}` : 'never contacted'} />
        <StatCard label="ACCOUNT" icon="verified_user" value={c.goneAt ? 'Gone' : c.verifiedAt ? 'Verified' : 'Not verified'} note={c.payoutEmail ? `payout to ${c.payoutEmail}` : 'no payout address'} />
      </div>
      <div className="lc-grid-2">
        <Card title="Handles">
          {Object.keys(c.handles).length === 0 && <span className="lc-muted" style={{ fontSize: 13 }}>No handles yet.</span>}
          {Object.entries(c.handles).map(([k, v]) => {
            const url = handleUrl(k, v!);
            return <KV key={k} k={fmt.titleCase(k)} v={url ? <a href={url} target="_blank" rel="noreferrer">{k === 'website' ? v : `@${v}`}</a> : v} />;
          })}
          {c.notes && <p style={{ fontSize: 13, color: 'var(--lc-text-2)', whiteSpace: 'pre-wrap', marginTop: 12 }}>{c.notes}</p>}
        </Card>
        <Card title="Playlists they curate" actions={<Link className="lc-btn lc-btn--sm" href="/marketing/playlists">All playlists</Link>}>
          {d.playlists.length === 0 && <span className="lc-muted" style={{ fontSize: 13 }}>None recorded.</span>}
          {d.playlists.map((p) => <KV key={p.id} k={p.url ? <a href={p.url} target="_blank" rel="noreferrer">{p.name}</a> : p.name} v={<span className="lc-mono" style={{ fontSize: 12 }}>{fmt.titleCase(p.platform.replace('_', ' '))} · {p.followers != null ? fmt.compact(p.followers) : '—'}</span>} />)}
        </Card>
      </div>
      <Card title="History" sub="Every logged conversation, including pitches sent from Outreach.">
        {d.interactions.length === 0 ? (
          <span className="lc-muted" style={{ fontSize: 13 }}>Nothing logged yet.</span>
        ) : (
          <Timeline items={d.interactions.map((i) => ({ time: fmt.shortDate(i.occurredAt), icon: CHANNEL_ICON[i.channel] ?? 'chat', who: i.direction === 'inbound' ? c.name : i.agentRunId ? 'Agent' : 'Label', what: i.summary, area: i.channel.toUpperCase() }))} />
        )}
      </Card>
      {rendered.map((p) => (
        <section key={p.id} className="lc-section">
          <h2 className="lc-h2" style={{ fontSize: 17 }}>{p.title}</h2>
          {p.node}
        </section>
      ))}
      {session.permissions.has('network:delete') && <div><ActionButton endpoint={`/network/contacts/${c.id}`} method="DELETE" label="Delete contact" icon="delete" variant="ghost" confirm={`Delete ${c.name}? Their interactions go with them.`} redirectTo="/marketing/contacts" /></div>}
      <Link href="/marketing/contacts" className="lc-btn lc-btn--link"><Icon name="arrow_back" />All contacts</Link>
    </Page>
  );
}
