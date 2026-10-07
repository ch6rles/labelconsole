'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Icon } from '@labelconsole/ui';
import type { FileKind } from '../../kinds';

/** A file as the viewer needs it. */
export type ViewerFile = { id: string; name: string; mime: string; size: number; kind: FileKind };
export type ViewerProps = { file: ViewerFile; compact?: boolean };

/** The file's bytes from the app itself (ranges, no bucket CORS), and as a download. */
export const contentUrl = (id: string) => `/api/v1/drive/files/${id}/content`;
export const downloadHref = (id: string) => `/api/v1/drive/files/${id}/content?download=1`;

export function ToolButton({ icon, title, onClick, active, disabled, label }: { icon: string; title: string; onClick: () => void; active?: boolean; disabled?: boolean; label?: string }) {
  return (
    <button type="button" className={`lc-fv-tool${active ? ' is-active' : ''}`} title={title} aria-label={title} aria-pressed={active} onClick={onClick} disabled={disabled}>
      <Icon name={icon} size={18} />
      {label && <span>{label}</span>}
    </button>
  );
}

export function Toolbar({ children }: { children: ReactNode }) {
  return (
    <div className="lc-fv-toolbar" role="toolbar">
      {children}
    </div>
  );
}

export const Spacer = () => <span className="lc-fv-spacer" />;
export const Divider = () => <span className="lc-fv-divider" aria-hidden />;

/** A message in place of a viewer: still loading, can't be shown, or failed. */
export function Notice({ icon, title, children, file, busy }: { icon: string; title: string; children?: ReactNode; file?: ViewerFile; busy?: boolean }) {
  return (
    <div className="lc-fv-notice" role={busy ? 'status' : undefined}>
      <Icon name={icon} size={32} className={busy ? 'lc-fv-spin' : undefined} />
      <strong>{title}</strong>
      {children && <span>{children}</span>}
      {file && (
        <a className="lc-btn lc-btn--sm" href={downloadHref(file.id)}>
          <Icon name="download" />
          Download {file.name.length > 40 ? 'file' : file.name}
        </a>
      )}
    </div>
  );
}

/** JSON from the app's API, with loading and error states. */
export function useJson<T>(url: string | null) {
  const [state, setState] = useState<{ data: T | null; error: string | null; loading: boolean }>({ data: null, error: null, loading: Boolean(url) });
  useEffect(() => {
    if (!url) return;
    let cancelled = false;
    setState({ data: null, error: null, loading: true });
    fetch(url, { credentials: 'same-origin' })
      .then(async (r) => {
        const body = await r.json().catch(() => null);
        if (!r.ok) throw new Error(body?.error?.message ?? `Request failed (${r.status})`);
        return body as T;
      })
      .then((data) => !cancelled && setState({ data, error: null, loading: false }))
      .catch((err: Error) => !cancelled && setState({ data: null, error: err.message, loading: false }));
    return () => {
      cancelled = true;
    };
  }, [url]);
  return state;
}

/**
 * Keyboard shortcuts while the viewer is in use, ignored while typing in a
 * field. Listens on the document, which hears a key before the window does,
 * so the file page's own keys (← → for the next file) only act on keys the
 * viewer left alone (not `defaultPrevented`).
 */
export function useKeys(handler: (e: KeyboardEvent) => void, enabled = true) {
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName))) return;
      if (e.metaKey || e.altKey) return;
      ref.current(e);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [enabled]);
}

/** The element's width, kept current as it resizes. */
export function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);
  return [ref, width] as const;
}

/* ---------------------------------------------------------------- find -- */

const MAX_MATCHES = 5000;

/**
 * Where a query occurs in an element's text, as DOM ranges (a match may span
 * several elements, e.g. syntax-coloured tokens). Text inside
 * `[data-find-skip]` (line numbers) is ignored.
 */
export function findRanges(root: Node, query: string): Range[] {
  const needle = query.toLowerCase();
  if (!needle.trim()) return [];
  const doc = root.ownerDocument ?? (root as Document);
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (n.parentElement?.closest('[data-find-skip], script, style') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });
  const nodes: Text[] = [];
  const starts: number[] = [];
  let text = '';
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    nodes.push(n as Text);
    starts.push(text.length);
    text += (n as Text).data;
  }
  return rangesFor(doc, nodes, starts, text.toLowerCase(), needle);
}

/** Ranges for each occurrence of `needle` in `hay`, the concatenated text of `nodes` (starting at `starts`). */
export function rangesFor(doc: Document, nodes: Text[], starts: number[], hay: string, needle: string): Range[] {
  const out: Range[] = [];
  let i = 0;
  for (let at = hay.indexOf(needle); at !== -1 && out.length < MAX_MATCHES; at = hay.indexOf(needle, at + needle.length)) {
    const end = at + needle.length;
    while (i < nodes.length - 1 && starts[i + 1] <= at) i++;
    let j = i;
    while (j < nodes.length - 1 && starts[j + 1] < end) j++;
    const r = doc.createRange();
    r.setStart(nodes[i], Math.min(at - starts[i], nodes[i].length));
    r.setEnd(nodes[j], Math.min(end - starts[j], nodes[j].length));
    out.push(r);
  }
  return out;
}

type HighlightWindow = Window & { Highlight?: new (...ranges: Range[]) => unknown; CSS: { highlights?: Map<string, unknown> } };

/** Paint every match and the current one (CSS Custom Highlight API); older browsers get the current match selected. */
export function paintMatches(win: Window | null | undefined, ranges: Range[], current: number) {
  const w = win as HighlightWindow | null | undefined;
  if (!w) return;
  if (w.Highlight && w.CSS.highlights) {
    w.CSS.highlights.set('lc-find', new w.Highlight(...ranges));
    w.CSS.highlights.set('lc-find-current', new w.Highlight(...(ranges[current] ? [ranges[current]] : [])));
  } else if (ranges[current]) {
    const sel = w.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(ranges[current]);
  }
}

export function clearMatches(win: Window | null | undefined) {
  const w = win as HighlightWindow | null | undefined;
  w?.CSS?.highlights?.delete('lc-find');
  w?.CSS?.highlights?.delete('lc-find-current');
}

/** Scroll a match into the middle of its scrolling box. */
export function revealRange(range: Range | undefined) {
  const el = range?.startContainer.parentElement;
  el?.scrollIntoView({ block: 'center', inline: 'nearest' });
}

/**
 * Find in page for a viewer's own content: matches painted, a count, and
 * next/previous. `version` changes whenever the content is re-rendered.
 */
export function useFind(root: () => Node | null | undefined, query: string, version: unknown) {
  const [ranges, setRanges] = useState<Range[]>([]);
  const [current, setCurrent] = useState(0);
  const rootFn = useRef(root);
  rootFn.current = root;
  useEffect(() => {
    const node = rootFn.current();
    const win = node?.ownerDocument?.defaultView;
    // Wait a beat so rapid typing doesn't re-scan a large document on every key.
    const t = setTimeout(() => {
      const found = node ? findRanges(node, query) : [];
      setRanges(found);
      setCurrent(0);
      paintMatches(win, found, 0);
      revealRange(found[0]);
    }, 120);
    return () => {
      clearTimeout(t);
      clearMatches(win);
    };
  }, [query, version]);
  const go = (dir: 1 | -1) => {
    if (!ranges.length) return;
    const next = (current + dir + ranges.length) % ranges.length;
    setCurrent(next);
    paintMatches(rootFn.current()?.ownerDocument?.defaultView, ranges, next);
    revealRange(ranges[next]);
  };
  return { count: ranges.length, current, next: () => go(1), prev: () => go(-1), capped: ranges.length >= MAX_MATCHES };
}

/** The search box in a viewer's toolbar: Enter for the next match, Shift+Enter for the previous, Ctrl+F or / to jump in. */
export function FindBox({ query, onQuery, count, current, onNext, onPrev, busy, capped, placeholder = 'Find' }: { query: string; onQuery: (q: string) => void; count: number; current: number; onNext: () => void; onPrev: () => void; busy?: boolean; capped?: boolean; placeholder?: string }) {
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      const typing = t && (t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName));
      // Ctrl/Cmd+F searches this file (the browser's own find can't see inside PDFs or frames).
      if ((e.key === 'f' && (e.ctrlKey || e.metaKey) && !e.altKey) || (e.key === '/' && !typing && !e.ctrlKey && !e.metaKey)) {
        if (!input.current?.offsetParent) return;
        e.preventDefault();
        input.current.focus();
        input.current.select();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  return (
    <span className="lc-fv-find">
      <Icon name="search" size={16} />
      <input
        ref={input}
        type="search"
        value={query}
        placeholder={placeholder}
        aria-label={placeholder}
        onChange={(e) => onQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            if (e.shiftKey) onPrev();
            else onNext();
          } else if (e.key === 'Escape') {
            onQuery('');
            input.current?.blur();
          }
        }}
      />
      {query && <span className="lc-fv-find-count">{busy ? '…' : count ? `${current + 1}/${count}${capped ? '+' : ''}` : '0'}</span>}
      {query && (
        <>
          <button type="button" className="lc-fv-tool" title="Previous match (Shift+Enter)" aria-label="Previous match" onClick={onPrev} disabled={!count}>
            <Icon name="keyboard_arrow_up" size={18} />
          </button>
          <button type="button" className="lc-fv-tool" title="Next match (Enter)" aria-label="Next match" onClick={onNext} disabled={!count}>
            <Icon name="keyboard_arrow_down" size={18} />
          </button>
        </>
      )}
    </span>
  );
}

/** A choice of a few modes (Rendered / Source), as a segmented control. */
export function Segmented<T extends string>({ value, options, onChange, label }: { value: T; options: Array<{ value: T; label: string; icon?: string }>; onChange: (v: T) => void; label: string }) {
  return (
    <span className="lc-fv-seg" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button key={o.value} type="button" role="radio" aria-checked={value === o.value} className={value === o.value ? 'is-active' : undefined} onClick={() => onChange(o.value)}>
          {o.icon && <Icon name={o.icon} size={16} />}
          {o.label}
        </button>
      ))}
    </span>
  );
}

/** A viewer setting remembered in this browser (wrap lines, font size); falls back to the default when storage is unavailable. */
export function usePref<T>(key: string, initial: T) {
  const [value, setValue] = useState<T>(initial);
  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(`lc-fv:${key}`);
      if (saved !== null) setValue(JSON.parse(saved) as T);
    } catch {
      /* private mode or blocked storage */
    }
  }, [key]);
  const set = (next: T) => {
    setValue(next);
    try {
      window.localStorage.setItem(`lc-fv:${key}`, JSON.stringify(next));
    } catch {
      /* not remembered */
    }
  };
  return [value, set] as const;
}

/** Copy text, with a moment of "copied" feedback. */
export function useCopy() {
  const [copied, setCopied] = useState(false);
  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  };
  return { copied, copy };
}

export function toggleFullscreen(el: HTMLElement | null) {
  if (!el) return;
  if (document.fullscreenElement) void document.exitFullscreen();
  else void el.requestFullscreen?.().catch(() => undefined);
}

export const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
export const duration = (s: number) => {
  if (!Number.isFinite(s)) return '–:––';
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`;
};
