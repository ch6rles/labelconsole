import type { PageProps } from '@labelconsole/core/web';
import { EmptyState, FilterPills, Icon, Page, PageHeader, Summary, fmt } from '@labelconsole/ui';
import { ActionButton } from '@labelconsole/ui/client';
import Link from 'next/link';
import { listNotifications } from '../service';

const ICON: Record<string, string> = { approval: 'approval', mention: 'alternate_email', alert: 'trending_up', reminder: 'event', agent: 'smart_toy', system: 'info', assignment: 'assignment_ind' };

export default async function NotificationsPage({ run, session, searchParams }: PageProps) {
  const unreadOnly = searchParams.filter === 'unread';
  const { items, unread } = await run((ctx) => listNotifications(ctx, session.user.id, { limit: 100, unread: unreadOnly ? '1' : undefined }));
  return (
    <Page variant="narrow">
      <PageHeader title="Notifications" description="Approvals, alerts, reminders and mentions addressed to you." actions={unread > 0 && <ActionButton endpoint="/inbox/notifications/read-all" label="Mark all read" icon="done_all" success="All caught up" />} />
      <FilterPills
        items={[
          { label: 'All', href: '/inbox', active: !unreadOnly },
          { label: 'Unread', count: unread, href: '/inbox?filter=unread', active: unreadOnly },
        ]}
      />
      <Summary>{unread} unread</Summary>
      {items.length === 0 ? (
        <EmptyState icon="notifications_off" title={unreadOnly ? 'No unread notifications' : 'Nothing here yet'}>
          Agents asking for approval, stream alerts, contract dates and new demos show up here.
        </EmptyState>
      ) : (
        <div className="lc-list">
          {items.map((n) => (
            <Link key={n.id} href={n.href ?? '/inbox'} className="lc-popover-item" style={{ padding: '14px 20px', boxShadow: n.readAt ? undefined : 'inset 2px 0 0 var(--lc-accent)' }}>
              <Icon name={ICON[n.kind] ?? 'notifications'} />
              <span style={{ display: 'flex', flexDirection: 'column', gap: 3, flex: 1, minWidth: 0 }}>
                <span style={{ fontSize: 14, fontWeight: n.readAt ? 400 : 600 }}>{n.title}</span>
                {n.body && <span className="lc-muted" style={{ fontSize: 13 }}>{n.body}</span>}
              </span>
              <span className="lc-mono lc-muted" style={{ fontSize: 11, whiteSpace: 'nowrap' }}>
                {n.actorLabel ? `${n.actorLabel} · ` : ''}
                {fmt.relative(n.createdAt)}
              </span>
            </Link>
          ))}
        </div>
      )}
    </Page>
  );
}
