import type { PageProps } from '@labelconsole/core/web';
import { Page, PageHeader, Summary } from '@labelconsole/ui';
import { FormModal } from '@labelconsole/ui/client';
import * as svc from '../service';

const TONE: Record<string, string> = { Full: 'lc-chip lc-chip--solid', Edit: 'lc-chip lc-chip--blue', View: 'lc-chip', '—': 'lc-chip lc-chip--muted' };

export default async function RolesPage({ run, session }: PageProps) {
  const m = await run((ctx) => svc.rolesMatrix(ctx));
  const n = m.columns.length;
  const canManage = session.permissions.has('settings:members');
  return (
    <Page>
      <PageHeader
        title="Roles & permissions"
        description="What each role can see and change across the apps. Agents act with a role too, capped by the person who created them."
        actions={
          canManage && (
            <FormModal
              title="New role"
              description="A custom role grants exactly the permissions you tick. You can only grant permissions you hold."
              trigger={{ label: 'New role', icon: 'add', variant: 'primary' }}
              endpoint="/settings/roles"
              wide
              fields={[
                { name: 'name', label: 'Name', required: true },
                { name: 'description', label: 'Description' },
                { name: 'permissions', label: 'Permissions', type: 'multiselect', full: true, options: m.permissions.map((p) => ({ value: p.key, label: p.key })) },
              ]}
              success="Role created"
            />
          )
        }
      />
      <Summary>
        {n} roles · owner role cannot be edited
      </Summary>
      <div className="lc-table-wrap">
        <div style={{ minWidth: 220 + n * 100 }}>
          <div style={{ display: 'grid', gridTemplateColumns: `minmax(220px,1.2fr) minmax(${n * 90}px,${n}fr)`, gap: 12, padding: '14px 16px', borderBottom: '1px solid var(--lc-border)' }}>
            <span className="lc-stat-label" style={{ alignSelf: 'end' }}>
              Area
            </span>
            <div style={{ display: 'grid', gridTemplateColumns: `repeat(${n},1fr)`, gap: 8 }}>
              {m.columns.map((c) => (
                <span key={c.key} style={{ display: 'flex', flexDirection: 'column', gap: 2, alignItems: 'center' }}>
                  <span style={{ fontSize: 13, fontWeight: 600 }}>{c.name}</span>
                  <span className="lc-mono lc-muted" style={{ fontSize: 11 }}>
                    {c.count} {c.count === 1 ? 'user' : 'users'}
                  </span>
                </span>
              ))}
            </div>
          </div>
          {m.rows.map((row) => (
            <div key={row.id} style={{ display: 'grid', gridTemplateColumns: `minmax(220px,1.2fr) minmax(${n * 90}px,${n}fr)`, gap: 12, alignItems: 'center', padding: '14px 16px', borderBottom: '1px solid var(--lc-divider)' }}>
              <span className="lc-cell-stack">
                <span className="lc-cell-strong">{row.name}</span>
                <span className="lc-cell-sub">{row.desc}</span>
              </span>
              <div style={{ display: 'grid', gridTemplateColumns: `repeat(${n},1fr)`, gap: 8, justifyItems: 'center' }}>
                {row.cells.map((v, i) => (
                  <span key={i} className={TONE[v]} style={{ minWidth: 56, justifyContent: 'center', justifySelf: 'center' }}>
                    {v}
                  </span>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
      <div className="lc-row" style={{ gap: 18, fontSize: 12, color: 'var(--lc-muted)' }}>
        <span>
          <strong style={{ color: 'var(--lc-ink)', fontWeight: 600 }}>Full</strong> can create, change, delete and export
        </span>
        <span>
          <strong style={{ color: 'var(--lc-ink)', fontWeight: 600 }}>Edit</strong> can create and change
        </span>
        <span>
          <strong style={{ color: 'var(--lc-ink)', fontWeight: 600 }}>View</strong> read only
        </span>
      </div>
    </Page>
  );
}
