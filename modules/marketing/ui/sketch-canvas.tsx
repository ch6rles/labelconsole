'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Icon } from '@labelconsole/ui';
import { useDebouncedCallback } from '@labelconsole/ui/hooks';
import { api, ApiError, Button } from '@labelconsole/ui/client';
import type { SketchItem } from '../schema';

type SaveState = 'saved' | 'dirty' | 'saving' | 'conflict' | 'error';
const COLORS: Array<NonNullable<SketchItem['color']>> = ['paper', 'blue', 'ink', 'red'];
const uid = () => Math.random().toString(36).slice(2, 10);

/**
 * Freeform marketing canvas: notes, references and timeline milestones.
 * Changes autosave; each save carries the version it was based on, so a
 * concurrent edit by someone else is reported instead of overwritten.
 */
export function SketchCanvas({ id, initialItems, initialVersion, canEdit }: { id: string; initialItems: SketchItem[]; initialVersion: number; canEdit: boolean }) {
  const [items, setItems] = useState<SketchItem[]>(initialItems);
  const [selected, setSelected] = useState<string | null>(null);
  const [state, setState] = useState<SaveState>('saved');
  const [error, setError] = useState<string | null>(null);
  const version = useRef(initialVersion);
  const latest = useRef(items);
  latest.current = items;
  const drag = useRef<{ id: string; mode: 'move' | 'resize'; startX: number; startY: number; orig: SketchItem } | null>(null);

  const save = useCallback(async () => {
    setState('saving');
    try {
      const res = await api<{ version: number }>(`/marketing/sketchboards/${id}/canvas`, { method: 'PUT', body: { items: latest.current, version: version.current } });
      version.current = res.version;
      setState('saved');
      setError(null);
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) setState('conflict');
      else {
        setState('error');
        setError((e as Error).message);
      }
    }
  }, [id]);
  const scheduleSave = useDebouncedCallback(() => void save(), 900);

  const change = (next: SketchItem[]) => {
    if (!canEdit || state === 'conflict') return;
    setItems(next);
    setState('dirty');
    scheduleSave();
  };
  const update = (itemId: string, patch: Partial<SketchItem>) => change(latest.current.map((i) => (i.id === itemId ? { ...i, ...patch } : i)));

  // Warn before leaving with unsaved changes.
  useEffect(() => {
    const onLeave = (e: BeforeUnloadEvent) => {
      if (state === 'dirty' || state === 'saving') e.preventDefault();
    };
    window.addEventListener('beforeunload', onLeave);
    return () => window.removeEventListener('beforeunload', onLeave);
  }, [state]);

  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.startX;
    const dy = e.clientY - d.startY;
    const snap = (v: number) => Math.max(0, Math.round(v / 10) * 10);
    setItems((list) => list.map((i) => (i.id !== d.id ? i : d.mode === 'move' ? { ...i, x: snap(d.orig.x + dx), y: snap(d.orig.y + dy) } : { ...i, w: Math.max(80, snap(d.orig.w + dx)), h: Math.max(40, snap(d.orig.h + dy)) })));
  };
  const onPointerUp = () => {
    if (!drag.current) return;
    drag.current = null;
    setState('dirty');
    scheduleSave();
  };

  const add = (type: SketchItem['type']) => {
    const maxY = latest.current.reduce((m, i) => Math.max(m, i.y + i.h), 0);
    const item: SketchItem =
      type === 'milestone'
        ? { id: uid(), type, x: 40, y: maxY + 30, w: 200, h: 90, text: 'Milestone', date: new Date().toISOString().slice(0, 10), color: 'ink' }
        : type === 'ref'
          ? { id: uid(), type, x: 40, y: maxY + 30, w: 260, h: 110, text: 'Reference', url: 'https://', color: 'blue' }
          : { id: uid(), type, x: 40, y: maxY + 30, w: 240, h: 120, text: '', color: 'paper' };
    change([...latest.current, item]);
    setSelected(item.id);
  };

  const sel = items.find((i) => i.id === selected) ?? null;
  // Milestones also read as a timeline, in date order.
  const timeline = items.filter((i) => i.type === 'milestone' && i.date).sort((a, b) => a.date!.localeCompare(b.date!));

  return (
    <div className="lc-stack" style={{ gap: 12 }}>
      <div className="lc-row" style={{ justifyContent: 'space-between' }}>
        {canEdit ? (
          <span className="lc-row" style={{ gap: 6 }}>
            <Button size="sm" icon="sticky_note_2" label="Note" onClick={() => add('note')} />
            <Button size="sm" icon="link" label="Reference" onClick={() => add('ref')} />
            <Button size="sm" icon="flag" label="Milestone" onClick={() => add('milestone')} />
            {sel && (
              <>
                <Button size="sm" icon="palette" label="Colour" onClick={() => update(sel.id, { color: COLORS[(COLORS.indexOf(sel.color ?? 'paper') + 1) % COLORS.length] })} />
                <Button size="sm" icon="delete" label="Remove" variant="ghost" onClick={() => { change(latest.current.filter((i) => i.id !== sel.id)); setSelected(null); }} />
              </>
            )}
          </span>
        ) : (
          <span className="lc-muted" style={{ fontSize: 13 }}>View only</span>
        )}
        <span className="lc-mono" style={{ fontSize: 12, color: state === 'conflict' || state === 'error' ? 'var(--lc-danger)' : 'var(--lc-muted)' }}>
          {state === 'saved' ? 'All changes saved' : state === 'saving' ? 'Saving…' : state === 'dirty' ? 'Unsaved changes' : state === 'conflict' ? 'Someone else changed this board' : `Not saved: ${error}`}
        </span>
      </div>
      {state === 'conflict' && (
        <div className="lc-banner is-warn">
          <Icon name="sync_problem" />
          <span>Someone else saved this board while you were editing. Reload to see their version; your last change was not saved. <a href="" onClick={(e) => { e.preventDefault(); window.location.reload(); }}>Reload</a></span>
        </div>
      )}
      <div className="lc-canvas" onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerLeave={onPointerUp} onClick={(e) => e.target === e.currentTarget && setSelected(null)}>
        {items.map((i) => (
          <div
            key={i.id}
            className={`lc-canvas-item${i.color && i.color !== 'paper' ? ` is-${i.color}` : ''}`}
            style={{ left: i.x, top: i.y, width: i.w, height: i.h, outline: selected === i.id ? '2px solid var(--lc-accent)' : undefined, zIndex: selected === i.id ? 2 : 1 }}
            onPointerDown={(e) => {
              setSelected(i.id);
              if (!canEdit || (e.target as HTMLElement).closest('textarea,input,a,[data-resize]')) return;
              (e.currentTarget.parentElement as HTMLElement).setPointerCapture?.(e.pointerId);
              drag.current = { id: i.id, mode: 'move', startX: e.clientX, startY: e.clientY, orig: i };
            }}
          >
            <span className="lc-row" style={{ gap: 6, fontSize: 11, fontFamily: 'var(--lc-font-mono)', opacity: 0.7 }}>
              <Icon name={i.type === 'milestone' ? 'flag' : i.type === 'ref' ? 'link' : 'sticky_note_2'} size={14} />
              {i.type === 'milestone' ? (canEdit ? <input type="date" value={i.date ?? ''} onChange={(e) => update(i.id, { date: e.target.value || undefined })} style={{ border: 'none', background: 'transparent', color: 'inherit', font: 'inherit' }} /> : i.date) : i.type === 'ref' ? 'REFERENCE' : 'NOTE'}
            </span>
            <textarea value={i.text} readOnly={!canEdit} placeholder="Write something…" onChange={(e) => update(i.id, { text: e.target.value })} />
            {i.type === 'ref' &&
              (canEdit && selected === i.id ? (
                <input className="lc-input" style={{ height: 28, fontSize: 12 }} value={i.url ?? ''} onChange={(e) => update(i.id, { url: e.target.value })} placeholder="https://" />
              ) : i.url && /^https?:\/\/.+\..+/.test(i.url) ? (
                <a href={i.url} target="_blank" rel="noreferrer" className="lc-ellipsis" style={{ fontSize: 12 }}>{i.url}</a>
              ) : null)}
            {canEdit && (
              <span
                data-resize
                title="Resize"
                style={{ position: 'absolute', right: 0, bottom: 0, width: 14, height: 14, cursor: 'nwse-resize' }}
                onPointerDown={(e) => {
                  e.stopPropagation();
                  setSelected(i.id);
                  (e.currentTarget.closest('.lc-canvas') as HTMLElement).setPointerCapture?.(e.pointerId);
                  drag.current = { id: i.id, mode: 'resize', startX: e.clientX, startY: e.clientY, orig: i };
                }}
              />
            )}
          </div>
        ))}
      </div>
      {timeline.length > 0 && (
        <div className="lc-card">
          <div className="lc-card-body">
            <span className="lc-field-label">Timeline</span>
            <div className="lc-row" style={{ gap: 0, marginTop: 10, overflowX: 'auto' }}>
              {timeline.map((m, idx) => (
                <div key={m.id} style={{ minWidth: 150, paddingRight: 16, borderTop: '2px solid var(--lc-ink)', paddingTop: 8, position: 'relative' }}>
                  <span style={{ position: 'absolute', top: -6, left: 0, width: 10, height: 10, background: idx === 0 ? 'var(--lc-accent)' : 'var(--lc-ink)' }} />
                  <div className="lc-mono" style={{ fontSize: 12, color: 'var(--lc-muted)' }}>{m.date}</div>
                  <div style={{ fontSize: 13, fontWeight: 500 }}>{m.text || 'Milestone'}</div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
