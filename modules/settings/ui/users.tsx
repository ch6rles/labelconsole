import { BUILT_IN_ROLES, ROLE_LABELS } from '@labelconsole/core/permissions';
import type { PageProps } from '@labelconsole/core/web';
import { Avatar, Chip, DataTable, Page, PageHeader, Summary, fmt } from '@labelconsole/ui';
import { ActionButton } from '@labelconsole/ui/client';
import * as svc from '../service';
import { InviteButton, RoleSelect } from './client';

type Row =
  | { kind: 'member'; id: string; name: string; email: string; role: string; roleLabel: string; access: string; last: Date | null; status: string; userId: string }
  | { kind: 'invite'; id: string; name: string; email: string; role: string; roleLabel: string; access: string; last: Date; status: string };

export default async function UsersPage({ run, session }: PageProps) {
  const { members, invitations } = await run((ctx) => svc.listMembers(ctx));
  const canManage = session.permissions.has('settings:members');
  const isOwner = session.permissions.has('settings:billing');
  const roleOptions = BUILT_IN_ROLES.filter((r) => isOwner || r !== 'owner').map((r) => ({ value: r, label: ROLE_LABELS[r] }));
  const active = members.filter((m) => m.status === 'active');
  const rows: Row[] = [
    ...active.map((m) => ({ kind: 'member' as const, id: m.membershipId, userId: m.userId, name: m.name, email: m.email, role: m.role, roleLabel: m.roleLabel, access: m.access, last: m.lastActiveAt, status: 'Active' })),
    ...invitations.map((i) => ({ kind: 'invite' as const, id: i.id, name: i.email.split('@')[0], email: i.email, role: i.role, roleLabel: i.roleLabel, access: '—', last: i.createdAt, status: 'Invited' })),
  ];
  return (
    <Page>
      <PageHeader title="Users" description={`People with access to ${session.org.name}.`} actions={canManage && <InviteButton roles={roleOptions} />} />
      <Summary>
        {active.length} member{active.length === 1 ? '' : 's'} · {invitations.length} invite{invitations.length === 1 ? '' : 's'} pending
      </Summary>
      <DataTable
        rows={rows}
        rowKey={(r) => `${r.kind}-${r.id}`}
        minWidth={1000}
        columns={[
          {
            key: 'user',
            header: 'User',
            width: 'minmax(260px,1.5fr)',
            render: (r) => (
              <span className="lc-cell-media">
                <Avatar name={r.name} round />
                <span className="lc-cell-stack">
                  <span className="lc-cell-strong">{r.name}</span>
                  <span className="lc-cell-sub lc-mono lc-ellipsis">{r.email}</span>
                </span>
              </span>
            ),
          },
          {
            key: 'role',
            header: 'Role',
            width: '150px',
            render: (r) =>
              canManage && r.kind === 'member' && r.userId !== session.user.id && (r.role !== 'owner' || isOwner) ? (
                <RoleSelect membershipId={r.id} role={r.role} roles={r.role === 'custom' ? [...roleOptions, { value: 'custom', label: r.roleLabel }] : roleOptions} />
              ) : (
                <Chip>{r.roleLabel}</Chip>
              ),
          },
          { key: 'access', header: 'Access', width: 'minmax(200px,1fr)', render: (r) => <span style={{ fontSize: 13, color: 'var(--lc-text-3)' }}>{r.access}</span> },
          { key: 'last', header: 'Last active', width: '130px', render: (r) => <span className="lc-muted" style={{ fontSize: 13 }}>{r.kind === 'invite' ? `Invite sent ${fmt.shortDate(r.last)}` : r.userId === session.user.id ? 'Now' : fmt.relative(r.last)}</span> },
          { key: 'status', header: 'Status', width: '100px', render: (r) => <Chip tone={r.status === 'Active' ? 'blue' : 'neutral'}>{r.status}</Chip> },
          {
            key: 'actions',
            header: '',
            width: '40px',
            align: 'right',
            render: (r) =>
              canManage && !(r.kind === 'member' && r.userId === session.user.id) ? (
                r.kind === 'invite' ? (
                  <ActionButton iconOnly icon="close" title="Revoke invitation" endpoint={`/settings/invitations/${r.id}`} method="DELETE" confirm={`Revoke the invitation for ${r.email}?`} variant="danger" success="Invitation revoked" />
                ) : (
                  <ActionButton iconOnly icon="person_remove" title="Remove from label" endpoint={`/settings/members/${r.id}`} method="DELETE" confirm={`Remove ${r.name} from ${session.org.name}? They lose access immediately.`} variant="danger" success="Member removed" />
                )
              ) : null,
          },
        ]}
      />
    </Page>
  );
}
