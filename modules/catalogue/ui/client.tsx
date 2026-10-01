'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { api, Button, useToast } from '@labelconsole/ui/client';
import { Icon } from '@labelconsole/ui';

export function ChecklistToggle({ releaseId, item, disabled }: { releaseId: string; item: { id: string; label: string; done: boolean }; disabled?: boolean }) {
  const [done, setDone] = useState(item.done);
  const router = useRouter();
  const toast = useToast();
  return (
    <div className="lc-kv">
      <button
        type="button"
        className="lc-row"
        style={{ gap: 8, border: 'none', background: 'none', padding: 0, cursor: disabled ? 'default' : 'pointer', fontSize: 13, color: 'var(--lc-ink)' }}
        disabled={disabled}
        onClick={async () => {
          setDone(!done);
          try {
            await api(`/catalogue/releases/${releaseId}/checklist`, { method: 'PATCH', body: { itemId: item.id, done: !done } });
            router.refresh();
          } catch (e) {
            setDone(done);
            toast((e as Error).message, 'error');
          }
        }}
      >
        <span className={`lc-checkbox-box${done ? ' is-on' : ''}`}>{done && <Icon name="check" />}</span>
        {item.label}
      </button>
      <span className="lc-muted" style={{ fontSize: 12 }}>{done ? 'done' : 'to do'}</span>
    </div>
  );
}

type Party = { name: string; email?: string | null; sharePct: number };

/** Edit a split sheet: parties and shares must total 100%. */
export function SplitEditor({ trackId, kind, initial, disabled }: { trackId: string; kind: 'master' | 'publishing'; initial: Party[]; disabled?: boolean }) {
  const [parties, setParties] = useState<Party[]>(initial.length ? initial : [{ name: '', sharePct: 100 }]);
  const [busy, setBusy] = useState(false);
  const router = useRouter();
  const toast = useToast();
  const total = parties.reduce((n, p) => n + (Number(p.sharePct) || 0), 0);
  const save = async (send: boolean) => {
    setBusy(true);
    try {
      await api(`/catalogue/tracks/${trackId}/splits`, { method: 'PUT', body: { kind, send, parties: parties.map((p) => ({ name: p.name, email: p.email || null, sharePct: Number(p.sharePct) })) } });
      toast(send ? 'Split sheet saved and marked as sent' : 'Split sheet saved');
      router.refresh();
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="lc-stack">
      {parties.map((p, i) => (
        <div key={i} style={{ display: 'grid', gridTemplateColumns: 'minmax(140px,1.4fr) minmax(140px,1fr) 90px 32px', gap: 8 }}>
          <input className="lc-input" placeholder="Party name" value={p.name} disabled={disabled} onChange={(e) => setParties((l) => l.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} />
          <input className="lc-input" placeholder="Email (optional)" value={p.email ?? ''} disabled={disabled} onChange={(e) => setParties((l) => l.map((x, j) => (j === i ? { ...x, email: e.target.value } : x)))} />
          <input className="lc-input" type="number" step="0.01" min={0} max={100} value={p.sharePct} disabled={disabled} onChange={(e) => setParties((l) => l.map((x, j) => (j === i ? { ...x, sharePct: Number(e.target.value) } : x)))} aria-label="Share percent" />
          <button type="button" className="lc-icon-btn is-danger" title="Remove party" disabled={disabled || parties.length === 1} onClick={() => setParties((l) => l.filter((_, j) => j !== i))}><Icon name="close" /></button>
        </div>
      ))}
      <div className="lc-row" style={{ justifyContent: 'space-between' }}>
        <Button size="xs" icon="add" label="Add party" disabled={disabled} onClick={() => setParties((l) => [...l, { name: '', sharePct: 0 }])} />
        <span className="lc-mono" style={{ fontSize: 12, color: Math.abs(total - 100) < 0.01 ? 'var(--lc-accent-fg)' : 'var(--lc-danger-fg)' }}>Total {Number(total.toFixed(2))}%</span>
      </div>
      {!disabled && (
        <div className="lc-form-actions">
          <Button label="Save draft" loading={busy} onClick={() => save(false)} />
          <Button variant="primary" label="Save and mark sent" loading={busy} onClick={() => save(true)} />
        </div>
      )}
    </div>
  );
}

export function SignToggle({ partyId, signed, disabled }: { partyId: string; signed: boolean; disabled?: boolean }) {
  const router = useRouter();
  const toast = useToast();
  return (
    <Button
      size="xs"
      icon={signed ? 'check_circle' : 'draw'}
      label={signed ? 'Signed' : 'Mark signed'}
      variant={signed ? undefined : 'primary'}
      disabled={disabled}
      onClick={async () => {
        try {
          await api(`/catalogue/split-parties/${partyId}`, { method: 'PATCH', body: { signed: !signed } });
          router.refresh();
        } catch (e) {
          toast((e as Error).message, 'error');
        }
      }}
    />
  );
}
