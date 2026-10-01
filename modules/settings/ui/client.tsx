'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { api, Button, CopyButton, EntityForm, Modal, Toggle, useToast } from '@labelconsole/ui/client';
import { usePersistedState } from '@labelconsole/ui/hooks';
import { Icon } from '@labelconsole/ui';

/** Same storage key the sidebar uses, so the two stay in sync (design: Sidebar apps). */
export function SidebarApps({ orgId, widgets }: { orgId: string; widgets: Array<{ id: string; name: string; icon: string; desc: string }> }) {
  const [pinned, setPinned, reset] = usePersistedState<string[]>(`labelconsole.pinned.${orgId}`, widgets.slice(0, 3).map((w) => w.id));
  return (
    <section className="lc-card">
      <div className="lc-card-head">
        <div className="lc-card-head-text">
          <span className="lc-card-title">Sidebar apps</span>
          <span className="lc-card-sub">Pick which app widgets appear in the side panel.</span>
        </div>
        <Button size="sm" label="Reset to defaults" onClick={reset} />
      </div>
      {widgets.map((w) => {
        const on = pinned.includes(w.id);
        return (
          <div key={w.id} className="lc-setting-row">
            <span className="lc-setting-icon">
              <Icon name={w.icon} />
            </span>
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 2 }}>
              <span style={{ fontSize: 14, fontWeight: 500 }}>{w.name}</span>
              <span style={{ fontSize: 12, color: 'var(--lc-muted)' }}>{w.desc}</span>
            </div>
            <Toggle on={on} title="Toggle widget" onChange={() => setPinned((p) => (on ? p.filter((x) => x !== w.id) : [...p, w.id]))} />
          </div>
        );
      })}
      {widgets.length === 0 && <div className="lc-card-body lc-muted">No app widgets are available for your role.</div>}
    </section>
  );
}

export function InviteButton({ roles }: { roles: Array<{ value: string; label: string }> }) {
  const [open, setOpen] = useState(false);
  const [link, setLink] = useState<string | null>(null);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState('viewer');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();
  const close = () => {
    setOpen(false);
    setLink(null);
    setEmail('');
    setError(null);
  };
  return (
    <>
      <Button variant="primary" icon="person_add" label="Invite user" onClick={() => setOpen(true)} />
      <Modal open={open} onClose={close} title={link ? 'Invitation created' : 'Invite user'} description={link ? 'We email it if an email account is connected. You can also share the link directly; it works once and expires in 14 days.' : undefined}>
        {link ? (
          <div className="lc-stack">
            <pre className="lc-code">{link}</pre>
            <div className="lc-form-actions">
              <CopyButton text={link} label="Copy link" />
              <Button variant="primary" label="Done" onClick={close} />
            </div>
          </div>
        ) : (
          <form
            className="lc-stack"
            onSubmit={async (e) => {
              e.preventDefault();
              setBusy(true);
              setError(null);
              try {
                const res = await api<{ url: string }>('/settings/invitations', { method: 'POST', body: { email, role } });
                setLink(res.url);
                router.refresh();
              } catch (err) {
                setError((err as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            <div className="lc-form-grid">
              <label className="lc-field">
                <span className="lc-field-label">Email</span>
                <input className="lc-input" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
              </label>
              <label className="lc-field">
                <span className="lc-field-label">Role</span>
                <select className="lc-select" value={role} onChange={(e) => setRole(e.target.value)}>
                  {roles.map((r) => (
                    <option key={r.value} value={r.value}>
                      {r.label}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            {error && <div className="lc-field-error">{error}</div>}
            <div className="lc-form-actions">
              <Button label="Cancel" onClick={close} />
              <Button type="submit" variant="primary" label="Send invitation" loading={busy} />
            </div>
          </form>
        )}
      </Modal>
    </>
  );
}

export function RoleSelect({ membershipId, role, roles, disabled }: { membershipId: string; role: string; roles: Array<{ value: string; label: string }>; disabled?: boolean }) {
  const router = useRouter();
  const toast = useToast();
  const [value, setValue] = useState(role);
  return (
    <select
      className="lc-select"
      style={{ height: 30, fontSize: 12, width: 'auto', padding: '0 8px' }}
      value={value}
      disabled={disabled}
      aria-label="Role"
      onChange={async (e) => {
        const next = e.target.value;
        const prev = value;
        setValue(next);
        try {
          await api(`/settings/members/${membershipId}`, { method: 'PATCH', body: { role: next } });
          toast('Role updated');
          router.refresh();
        } catch (err) {
          setValue(prev);
          toast((err as Error).message, 'error');
        }
      }}
    >
      {roles.map((r) => (
        <option key={r.value} value={r.value}>
          {r.label}
        </option>
      ))}
    </select>
  );
}

export function DeleteLabel({ name }: { name: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="danger" icon="delete_forever" label="Delete label" onClick={() => setOpen(true)} />
      <Modal open={open} onClose={() => setOpen(false)} title="Delete this label" description={`This permanently deletes ${name}: every release, artist, document, file, stream history and agent. Export first if you need a copy.`}>
        <EntityForm
          endpoint="/settings/delete-label"
          fields={[{ name: 'confirm', label: `Type "${name}" to confirm`, required: true, full: true }]}
          submitLabel="Delete permanently"
          success="Deletion scheduled. It runs in one minute."
          onDone={() => setOpen(false)}
          cancel={() => setOpen(false)}
          columns={1}
        />
      </Modal>
    </>
  );
}
