import type { PageProps } from '@labelconsole/core/web';
import { Avatar, Chip, DataTable, Page, PageHeader, Summary, fmt } from '@labelconsole/ui';
import { FormModal } from '@labelconsole/ui/client';
import * as svc from '../service';

export default async function StaffPage({ run, session }: PageProps) {
  const staff = await run((ctx) => svc.listStaff(ctx));
  const me = staff.find((s) => s.userId === session.user.id);
  const departments = new Set(staff.map((s) => s.profile?.department).filter(Boolean));
  return (
    <Page>
      <PageHeader
        title="Staff"
        description="Who works at the label, what they do and how to reach them. Access is managed under Admin → Users."
        actions={me && <FormModal title="Your staff profile" trigger={{ label: 'Edit my profile', icon: 'badge' }} endpoint={`/people/staff/${session.user.id}`} method="PATCH" initial={me.profile ?? {}} fields={[{ name: 'title', label: 'Title' }, { name: 'department', label: 'Department' }, { name: 'phone', label: 'Phone' }, { name: 'bio', label: 'Bio', type: 'textarea' }]} />}
      />
      <Summary>
        {staff.length} people · {departments.size} departments
      </Summary>
      <DataTable
        rows={staff}
        rowKey={(s) => s.userId}
        minWidth={900}
        columns={[
          { key: 'name', header: 'Person', width: 'minmax(240px,1.4fr)', render: (s) => <span className="lc-cell-media"><Avatar name={s.name} round /><span className="lc-cell-stack"><span className="lc-cell-strong">{s.name}</span><span className="lc-cell-sub lc-mono">{s.email}</span></span></span> },
          { key: 'title', header: 'Title', width: 'minmax(160px,1fr)', render: (s) => s.profile?.title ?? '—' },
          { key: 'dept', header: 'Department', width: '160px', render: (s) => s.profile?.department ?? '—' },
          { key: 'role', header: 'Role', width: '120px', render: (s) => <Chip>{s.roleLabel}</Chip> },
          { key: 'last', header: 'Last active', width: '130px', render: (s) => <span className="lc-muted">{fmt.relative(s.lastActiveAt)}</span> },
        ]}
      />
    </Page>
  );
}
