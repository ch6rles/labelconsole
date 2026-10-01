'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { api, Button, useToast } from '@labelconsole/ui/client';
import { Icon } from '@labelconsole/ui';

export function ImportBox() {
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();
  return (
    <form
      className="lc-stack"
      onSubmit={async (e) => {
        e.preventDefault();
        if (!value.trim()) return;
        setBusy(true);
        setError(null);
        try {
          const lookup = await api<{ id: string }>('/metadata/resolve', { method: 'POST', body: { input: value.trim() } });
          router.push(`/catalog/import/${lookup.id}`);
        } catch (err) {
          setError((err as Error).message);
          setBusy(false);
        }
      }}
    >
      <div className="lc-row" style={{ gap: 8, flexWrap: 'nowrap' }}>
        <label className="lc-search" style={{ flex: 1, width: 'auto' }}>
          <Icon name="link" />
          <input value={value} onChange={(e) => setValue(e.target.value)} placeholder="Spotify, Apple Music, Deezer or YouTube link · ISRC · UPC · “Artist - Title”" aria-label="What to import" autoFocus />
        </label>
        <Button type="submit" variant="primary" icon="travel_explore" label="Look up" loading={busy} />
      </div>
      {error && <span className="lc-field-error">{error}</span>}
    </form>
  );
}

export function ConfirmImport({ lookupId, initial }: { lookupId: string; initial: { title: string; type: string; releaseDate: string; labelName: string; distributor: string; artistNames: string; status: string } }) {
  const [v, setV] = useState(initial);
  const [busy, setBusy] = useState(false);
  const router = useRouter();
  const toast = useToast();
  const set = (k: keyof typeof v) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setV((s) => ({ ...s, [k]: e.target.value }));
  return (
    <form
      className="lc-stack"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        try {
          const res = await api<{ releaseId: string; created: boolean; tracks: number }>(`/metadata/resolve/${lookupId}/confirm`, {
            method: 'POST',
            body: { title: v.title, type: v.type, releaseDate: v.releaseDate || null, labelName: v.labelName || null, distributor: v.distributor || null, artistNames: v.artistNames.split(',').map((s) => s.trim()).filter(Boolean), status: v.status },
          });
          toast(res.created ? `Imported ${res.tracks} track${res.tracks === 1 ? '' : 's'}` : 'Linked to the existing release');
          router.push(`/catalog/releases/${res.releaseId}`);
        } catch (err) {
          toast((err as Error).message, 'error');
          setBusy(false);
        }
      }}
    >
      <div className="lc-form-grid">
        <label className="lc-field"><span className="lc-field-label">Release title</span><input className="lc-input" value={v.title} onChange={set('title')} required /></label>
        <label className="lc-field"><span className="lc-field-label">Artists (comma separated)</span><input className="lc-input" value={v.artistNames} onChange={set('artistNames')} /></label>
        <label className="lc-field"><span className="lc-field-label">Type</span><select className="lc-select" value={v.type} onChange={set('type')}><option value="single">Single</option><option value="ep">EP</option><option value="album">Album</option><option value="compilation">Compilation</option></select></label>
        <label className="lc-field"><span className="lc-field-label">Release date</span><input className="lc-input" type="date" value={v.releaseDate} onChange={set('releaseDate')} /></label>
        <label className="lc-field"><span className="lc-field-label">Label name</span><input className="lc-input" value={v.labelName} onChange={set('labelName')} /></label>
        <label className="lc-field"><span className="lc-field-label">Distributor</span><input className="lc-input" value={v.distributor} onChange={set('distributor')} /><span className="lc-field-hint">Confirming teaches the label-string and UPC-prefix tables.</span></label>
        <label className="lc-field"><span className="lc-field-label">Status</span><select className="lc-select" value={v.status} onChange={set('status')}><option value="live">Live</option><option value="scheduled">Scheduled</option><option value="draft">Draft</option><option value="collecting">Collecting</option></select></label>
      </div>
      <div className="lc-form-actions"><Button type="submit" variant="primary" icon="download_done" label="Create release and tracks" loading={busy} /></div>
    </form>
  );
}
