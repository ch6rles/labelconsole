'use client';

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent, type RefObject, type WheelEvent as ReactWheelEvent } from 'react';
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist';
import { Icon } from '@labelconsole/ui';
import { Divider, FindBox, Notice, Spacer, ToolButton, Toolbar, clamp, clearMatches, contentUrl, paintMatches, toggleFullscreen, useKeys, type ViewerProps } from './shared';

type PdfLib = typeof import('pdfjs-dist');
type TextItem = { str: string; hasEOL: boolean };
type PageText = { content: Awaited<ReturnType<PDFPageProxy['getTextContent']>>; items: TextItem[]; hay: string; starts: number[] };
type Hit = { page: number; start: number; end: number };
type OutlineNode = { title: string; dest: unknown; url: string | null; items: OutlineNode[] };
type LinkBox = { left: number; top: number; width: number; height: number; url?: string; dest?: unknown };

/** PDF points to CSS pixels: "100%" shows a page at its printed size. */
const CSS_UNITS = 96 / 72;
const GAP = 16;
/** Canvases beyond ~16 megapixels fail on iPhones; sharpness is capped instead. */
const MAX_CANVAS_PIXELS = 16_000_000;
const ZOOMS = [0.25, 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5];

let lib: Promise<PdfLib> | null = null;
/** pdf.js, loaded on first use, parsing in its own worker. */
function pdfjs() {
  lib ??= import('pdfjs-dist/legacy/build/pdf.mjs').then((m) => {
    const pdf = m as unknown as PdfLib;
    if (!pdf.GlobalWorkerOptions.workerPort) pdf.GlobalWorkerOptions.workerPort = new Worker(new URL('./pdf-worker.ts', import.meta.url), { type: 'module' });
    return pdf;
  });
  return lib;
}

const isCancel = (err: unknown) => (err as Error | null)?.name === 'RenderingCancelledException' || (err as Error | null)?.name === 'AbortException';

/**
 * PDFs drawn by pdf.js: every page in one scrolling column, rendered as it
 * comes into view; selectable text; search across the whole document;
 * thumbnails and the document's outline; zoom, rotate, page jumps; links that
 * work; password-protected files; document properties.
 */
export function PdfViewer({ file, compact }: ViewerProps) {
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [pdf, setPdf] = useState<PdfLib | null>(null);
  const [sizes, setSizes] = useState<Array<{ w: number; h: number }>>([]);
  const [error, setError] = useState<string | null>(null);
  const [password, setPassword] = useState<{ submit: (p: string) => void; wrong: boolean } | null>(null);
  const [progress, setProgress] = useState(0);
  const [zoom, setZoom] = useState<'width' | 'page' | number>('width');
  const [rotation, setRotation] = useState(0);
  const [current, setCurrent] = useState(1);
  const [sidebar, setSidebar] = useState<'thumbs' | 'outline' | null>(null);
  const [outline, setOutline] = useState<OutlineNode[] | null>(null);
  const [night, setNight] = useState(false);
  const [showInfo, setShowInfo] = useState(false);
  const [box, setBox] = useState({ w: 0, h: 0 });
  const [pageInput, setPageInput] = useState('1');
  const scroller = useRef<HTMLDivElement>(null);
  const root = useRef<HTMLDivElement>(null);
  const texts = useRef(new Map<number, Promise<PageText>>());
  const layers = useRef(new Map<number, HTMLElement[]>());
  const [layersVersion, setLayersVersion] = useState(0);
  const anchor = useRef({ page: 1, frac: 0 });

  // Load the document (ranges: a large PDF's first page shows before the rest arrives).
  useEffect(() => {
    let cancelled = false;
    let task: ReturnType<PdfLib['getDocument']> | null = null;
    texts.current.clear();
    layers.current.clear();
    (async () => {
      const p = await pdfjs();
      if (cancelled) return;
      task = p.getDocument({ url: contentUrl(file.id), enableXfa: false, rangeChunkSize: 1 << 20 });
      task.onPassword = (submit: (pw: string) => void, reason: number) => setPassword({ submit, wrong: reason === p.PasswordResponses.INCORRECT_PASSWORD });
      task.onProgress = ({ loaded, total }: { loaded: number; total: number }) => total && setProgress(loaded / total);
      const d = await task.promise;
      if (cancelled) return;
      setPassword(null);
      const out: Array<{ w: number; h: number }> = [];
      for (let i = 1; i <= d.numPages; i += 64) {
        const batch = await Promise.all(Array.from({ length: Math.min(64, d.numPages - i + 1) }, (_, k) => d.getPage(i + k)));
        for (const page of batch) {
          const v = page.getViewport({ scale: 1 });
          out.push({ w: v.width, h: v.height });
        }
      }
      if (cancelled) return;
      setPdf(p);
      setSizes(out);
      setDoc(d);
      d.getOutline()
        .then((o) => !cancelled && setOutline((o as unknown as OutlineNode[] | null) ?? []))
        .catch(() => setOutline([]));
    })().catch((err: Error) => {
      if (cancelled || isCancel(err)) return;
      setError(err.name === 'InvalidPDFException' ? 'This file isn’t a valid PDF, or it’s damaged.' : err.message);
    });
    return () => {
      cancelled = true;
      void task?.destroy();
    };
  }, [file.id]);

  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setBox({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, [doc]);

  // Thumbnails open by default when there's room for them.
  useEffect(() => {
    if (doc && !compact && box.w > 900 && doc.numPages > 1) setSidebar((s) => s ?? 'thumbs');
    // Only on first load.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc]);

  const turned = rotation % 180 !== 0;
  const dims = useMemo(() => sizes.map((s) => (turned ? { w: s.h, h: s.w } : s)), [sizes, turned]);
  const widest = dims.reduce((m, d) => Math.max(m, d.w), 0) || 612;
  const scale = useMemo(() => {
    if (typeof zoom === 'number') return zoom;
    const avail = Math.max(120, box.w - GAP * 2);
    const byWidth = avail / (widest * CSS_UNITS);
    if (zoom === 'width') return clamp(byWidth, 0.1, compact ? 2 : 3);
    const d = dims[current - 1] ?? dims[0] ?? { w: 612, h: 792 };
    return clamp(Math.min(avail / (d.w * CSS_UNITS), (box.h - GAP * 2) / (d.h * CSS_UNITS)), 0.1, 5);
    // `current` only matters when the zoom is set, not as you scroll.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [zoom, box.w, box.h, widest, dims, compact]);

  const tops = useMemo(() => {
    const out: number[] = [];
    let y = GAP;
    for (const d of dims) {
      out.push(y);
      y += d.h * CSS_UNITS * scale + GAP;
    }
    out.push(y);
    return out;
  }, [dims, scale]);

  const pageAt = useCallback(
    (y: number) => {
      let lo = 0;
      let hi = dims.length - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (tops[mid] <= y) lo = mid;
        else hi = mid - 1;
      }
      return lo + 1;
    },
    [tops, dims.length],
  );

  const onScroll = () => {
    const el = scroller.current;
    if (!el || !dims.length) return;
    const page = pageAt(el.scrollTop + el.clientHeight * 0.35);
    setCurrent(page);
    const top = pageAt(el.scrollTop);
    anchor.current = { page: top, frac: (el.scrollTop - tops[top - 1]) / (tops[top] - tops[top - 1]) };
  };
  useEffect(() => setPageInput(String(current)), [current]);

  // Keep the same spot in view when zooming or rotating.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el || !dims.length) return;
    const { page, frac } = anchor.current;
    el.scrollTop = tops[page - 1] + frac * (tops[page] - tops[page - 1]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scale, rotation]);

  const goTo = useCallback(
    (page: number, offsetY = 0) => {
      const el = scroller.current;
      if (!el || !dims.length) return;
      const p = clamp(Math.round(page), 1, dims.length);
      el.scrollTo({ top: tops[p - 1] - GAP / 2 + offsetY });
      setCurrent(p);
    },
    [tops, dims.length],
  );

  const goToDest = useCallback(
    async (dest: unknown) => {
      if (!doc) return;
      const explicit = typeof dest === 'string' ? await doc.getDestination(dest) : dest;
      if (!Array.isArray(explicit)) return;
      const ref = explicit[0];
      const index = typeof ref === 'number' ? ref : ref && typeof ref === 'object' ? await doc.getPageIndex(ref as Parameters<PDFDocumentProxy['getPageIndex']>[0]).catch(() => null) : null;
      if (index !== null) goTo(index + 1);
    },
    [doc, goTo],
  );

  const textOf = useCallback(
    (n: number) => {
      if (!doc) return Promise.reject(new Error('not loaded'));
      let t = texts.current.get(n);
      if (!t) {
        t = doc
          .getPage(n)
          .then((page) => page.getTextContent())
          .then((content) => {
            const items = (content.items as Array<Partial<TextItem>>).filter((i): i is TextItem => typeof i.str === 'string');
            const starts: number[] = [];
            let hay = '';
            for (const i of items) {
              starts.push(hay.length);
              hay += i.str + (i.hasEOL ? ' ' : '');
            }
            return { content, items, hay: hay.toLowerCase(), starts };
          });
        texts.current.set(n, t);
      }
      return t;
    },
    [doc],
  );

  /* ---- search across every page ---- */
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<Hit[]>([]);
  const [hit, setHit] = useState(0);
  const [searching, setSearching] = useState(false);
  useEffect(() => {
    const needle = query.trim().toLowerCase().replace(/\s+/g, ' ');
    if (!doc || !needle) {
      setHits([]);
      return;
    }
    let cancelled = false;
    setSearching(true);
    const t = setTimeout(async () => {
      const found: Hit[] = [];
      for (let n = 1; n <= doc.numPages && !cancelled; n++) {
        const { hay } = await textOf(n);
        for (let at = hay.indexOf(needle); at !== -1 && found.length < 5000; at = hay.indexOf(needle, at + needle.length)) found.push({ page: n, start: at, end: at + needle.length });
        // Show the first matches while the rest of a long document is searched.
        if (n === 1 || n % 25 === 0) !cancelled && setHits([...found]);
      }
      if (cancelled) return;
      setHits(found);
      setSearching(false);
      setHit(0);
      if (found[0]) revealHit(found[0]);
    }, 200);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, doc]);

  const revealHit = (h: Hit) => {
    const el = scroller.current;
    if (!el) return;
    // Bring the page in; the highlight effect centres the match once its text layer exists.
    if (pageAt(el.scrollTop) > h.page || pageAt(el.scrollTop + el.clientHeight) < h.page) goTo(h.page);
    pendingReveal.current = h;
    setLayersVersion((v) => v + 1);
  };
  const pendingReveal = useRef<Hit | null>(null);

  // Paint matches on pages whose text layer is on screen.
  useEffect(() => {
    const win = root.current?.ownerDocument.defaultView;
    if (!hits.length) {
      clearMatches(win);
      return;
    }
    let cancelled = false;
    (async () => {
      const ranges: Range[] = [];
      let currentRange: Range | undefined;
      const byPage = new Map<number, Hit[]>();
      hits.forEach((h) => byPage.set(h.page, [...(byPage.get(h.page) ?? []), h]));
      for (const [page, divs] of layers.current) {
        const list = byPage.get(page);
        if (!list) continue;
        const t = await textOf(page);
        const nodes: Text[] = [];
        const starts: number[] = [];
        divs.forEach((d, i) => {
          if (d.firstChild instanceof Text) {
            nodes.push(d.firstChild);
            starts.push(t.starts[i]);
          }
        });
        if (!nodes.length) continue;
        for (const h of list) {
          const r = rangesForHit(document, nodes, starts, h);
          if (!r) continue;
          ranges.push(r);
          if (hits[hit] === h) currentRange = r;
        }
      }
      if (cancelled) return;
      const all = currentRange ? [...ranges.filter((r) => r !== currentRange), currentRange] : ranges;
      paintMatches(win, all, currentRange ? all.length - 1 : -1);
      const want = pendingReveal.current;
      if (want && currentRange && hits[hit] === want) {
        pendingReveal.current = null;
        currentRange.startContainer.parentElement?.scrollIntoView({ block: 'center', inline: 'nearest' });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [hits, hit, layersVersion, textOf]);
  useEffect(() => () => clearMatches(root.current?.ownerDocument.defaultView), []);

  const stepHit = (dir: 1 | -1) => {
    if (!hits.length) return;
    const next = (hit + dir + hits.length) % hits.length;
    setHit(next);
    revealHit(hits[next]);
  };

  const onLayer = useCallback((page: number, divs: HTMLElement[] | null) => {
    if (divs) layers.current.set(page, divs);
    else layers.current.delete(page);
    setLayersVersion((v) => v + 1);
  }, []);

  /* ---- zoom ---- */
  const setScale = (s: number | 'width' | 'page') => setZoom(typeof s === 'number' ? clamp(s, 0.1, 5) : s);
  const stepZoom = (dir: 1 | -1) => {
    const next = dir > 0 ? ZOOMS.find((z) => z > scale + 0.001) : [...ZOOMS].reverse().find((z) => z < scale - 0.001);
    setScale(next ?? (dir > 0 ? 5 : 0.1));
  };
  const onWheel = (e: ReactWheelEvent) => {
    if (!e.ctrlKey) return;
    setScale(scale * Math.exp(-e.deltaY * 0.01));
  };
  // React's wheel listener is passive, so Ctrl+wheel needs a native one to stop the browser zooming the whole page.
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const stop = (e: WheelEvent) => e.ctrlKey && e.preventDefault();
    el.addEventListener('wheel', stop, { passive: false });
    return () => el.removeEventListener('wheel', stop);
  }, [doc]);

  useKeys(
    (e) => {
      if (!doc) return;
      if (e.ctrlKey && (e.key === '=' || e.key === '+')) stepZoom(1);
      else if (e.ctrlKey && e.key === '-') stepZoom(-1);
      else if (e.ctrlKey) return;
      else if (e.key === '+' || e.key === '=') stepZoom(1);
      else if (e.key === '-') stepZoom(-1);
      else if (e.key === '0') setScale('width');
      else if (e.key === '9') setScale('page');
      else if (e.key === '1') setScale(1);
      else if (e.key === 'ArrowRight' || e.key === 'n' || e.key === 'j') goTo(current + 1);
      else if (e.key === 'ArrowLeft' || e.key === 'p' || e.key === 'k') goTo(current - 1);
      else if (e.key === 'Home') goTo(1);
      else if (e.key === 'End') goTo(doc.numPages);
      else if (e.key.toLowerCase() === 'r') setRotation((r) => (r + (e.shiftKey ? 270 : 90)) % 360);
      else return;
      e.preventDefault();
    },
    !compact,
  );

  const submitPage = (e: FormEvent) => {
    e.preventDefault();
    const n = Number(pageInput);
    if (Number.isFinite(n)) goTo(n);
  };

  if (error) return <Notice icon="error" title="This PDF couldn’t be opened" file={file}>{error}</Notice>;
  if (password) return <PasswordPrompt wrong={password.wrong} onSubmit={(pw) => password.submit(pw)} />;

  return (
    <div className={`lc-fv lc-fv-pdf${night ? ' is-night' : ''}`} ref={root}>
      <Toolbar>
        {!compact && <ToolButton icon="view_sidebar" title="Thumbnails and outline" onClick={() => setSidebar((s) => (s ? null : 'thumbs'))} active={Boolean(sidebar)} disabled={!doc} />}
        <ToolButton icon="keyboard_arrow_up" title="Previous page (←)" onClick={() => goTo(current - 1)} disabled={!doc || current <= 1} />
        <form onSubmit={submitPage} className="lc-fv-pageno">
          <input value={pageInput} onChange={(e) => setPageInput(e.target.value.replace(/\D/g, ''))} onBlur={() => setPageInput(String(current))} inputMode="numeric" aria-label="Page number" disabled={!doc} />
          <span>/ {doc?.numPages ?? '–'}</span>
        </form>
        <ToolButton icon="keyboard_arrow_down" title="Next page (→)" onClick={() => goTo(current + 1)} disabled={!doc || current >= (doc?.numPages ?? 0)} />
        <Divider />
        <ToolButton icon="zoom_out" title="Zoom out (−)" onClick={() => stepZoom(-1)} disabled={!doc} />
        <select className="lc-fv-select" value={typeof zoom === 'number' ? 'custom' : zoom} onChange={(e) => setScale(e.target.value === 'width' || e.target.value === 'page' ? e.target.value : Number(e.target.value))} aria-label="Zoom" disabled={!doc}>
          <option value="width">Fit width</option>
          <option value="page">Fit page</option>
          {typeof zoom === 'number' && <option value="custom">{Math.round(scale * 100)}%</option>}
          {ZOOMS.map((z) => (
            <option key={z} value={z}>
              {Math.round(z * 100)}%
            </option>
          ))}
        </select>
        <ToolButton icon="zoom_in" title="Zoom in (+)" onClick={() => stepZoom(1)} disabled={!doc} />
        {!compact && <ToolButton icon="rotate_right" title="Rotate (R)" onClick={() => setRotation((r) => (r + 90) % 360)} disabled={!doc} />}
        <Spacer />
        <FindBox query={query} onQuery={setQuery} count={hits.length} current={hit} onNext={() => stepHit(1)} onPrev={() => stepHit(-1)} busy={searching} placeholder="Find in PDF" />
        {!compact && <ToolButton icon="dark_mode" title="Night mode (inverts the pages)" onClick={() => setNight((v) => !v)} active={night} disabled={!doc} />}
        {!compact && <ToolButton icon="info" title="Document properties" onClick={() => setShowInfo((v) => !v)} active={showInfo} disabled={!doc} />}
        <ToolButton icon="print" title="Print (opens the browser’s PDF viewer)" onClick={() => window.open(`/api/v1/drive/files/${file.id}/download?inline=1`, '_blank', 'noopener')} />
        <ToolButton icon="fullscreen" title="Full screen" onClick={() => toggleFullscreen(root.current)} />
      </Toolbar>
      <div className="lc-fv-body">
        {sidebar && doc && pdf && (
          <aside className="lc-fv-side">
            <div className="lc-fv-side-tabs">
              <button type="button" className={sidebar === 'thumbs' ? 'is-active' : undefined} onClick={() => setSidebar('thumbs')}>
                Pages
              </button>
              <button type="button" className={sidebar === 'outline' ? 'is-active' : undefined} onClick={() => setSidebar('outline')} disabled={!outline?.length} title={outline?.length ? undefined : 'This PDF has no outline'}>
                Outline
              </button>
            </div>
            {sidebar === 'thumbs' ? <Thumbnails doc={doc} sizes={sizes} rotation={rotation} current={current} onPick={goTo} /> : <Outline nodes={outline ?? []} onPick={goToDest} />}
          </aside>
        )}
        <div className="lc-fv-stage lc-fv-pdf-pages" ref={scroller} onScroll={onScroll} onWheel={onWheel} tabIndex={0}>
          {!doc && <Notice busy icon="progress_activity" title="Opening PDF…">{progress > 0 && progress < 1 ? `${Math.round(progress * 100)}%` : null}</Notice>}
          {doc && pdf && (
            <div style={{ height: tops[tops.length - 1], position: 'relative', minWidth: widest * CSS_UNITS * scale + GAP * 2 }}>
              {dims.map((d, i) => (
                <PdfPage
                  key={i}
                  pdf={pdf}
                  doc={doc}
                  n={i + 1}
                  top={tops[i]}
                  width={d.w * CSS_UNITS * scale}
                  height={d.h * CSS_UNITS * scale}
                  scale={scale}
                  rotation={rotation}
                  scroller={scroller}
                  textOf={textOf}
                  onLayer={onLayer}
                  onDest={goToDest}
                />
              ))}
            </div>
          )}
        </div>
        {showInfo && doc && pdf && <Properties doc={doc} pdf={pdf} file={file} sizes={sizes} onClose={() => setShowInfo(false)} />}
      </div>
    </div>
  );
}

function rangesForHit(doc: Document, nodes: Text[], starts: number[], h: Hit): Range | null {
  // Matches are found in the page text joined with spaces at line ends; map back to the text spans.
  let i = 0;
  while (i < nodes.length - 1 && starts[i + 1] <= h.start) i++;
  if (h.start - starts[i] >= nodes[i].length) {
    // Starts on a line-end space: begin at the next span.
    if (i === nodes.length - 1) return null;
    i++;
  }
  let j = i;
  while (j < nodes.length - 1 && starts[j + 1] < h.end) j++;
  const r = doc.createRange();
  r.setStart(nodes[i], Math.max(0, Math.min(h.start - starts[i], nodes[i].length)));
  r.setEnd(nodes[j], Math.max(0, Math.min(h.end - starts[j], nodes[j].length)));
  return r;
}

/** One page: drawn when near the screen and let go when far from it, so long documents stay light. */
function PdfPage({ pdf, doc, n, top, width, height, scale, rotation, scroller, textOf, onLayer, onDest }: {
  pdf: PdfLib;
  doc: PDFDocumentProxy;
  n: number;
  top: number;
  width: number;
  height: number;
  scale: number;
  rotation: number;
  scroller: RefObject<HTMLDivElement | null>;
  textOf: (n: number) => Promise<PageText>;
  onLayer: (page: number, divs: HTMLElement[] | null) => void;
  onDest: (dest: unknown) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const canvasHolder = useRef<HTMLDivElement>(null);
  const textHolder = useRef<HTMLDivElement>(null);
  const [near, setNear] = useState(false);
  const [links, setLinks] = useState<LinkBox[]>([]);
  const [drawn, setDrawn] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(([entry]) => setNear(entry.isIntersecting), { root: scroller.current, rootMargin: '150% 0px' });
    io.observe(el);
    return () => io.disconnect();
  }, [scroller]);

  useEffect(() => {
    if (!near) {
      // Far off screen: free the canvas memory (iOS caps the total).
      const old = canvasHolder.current?.querySelector('canvas');
      if (old) {
        old.width = 0;
        old.height = 0;
      }
      canvasHolder.current?.replaceChildren();
      textHolder.current?.replaceChildren();
      setDrawn(false);
      onLayer(n, null);
      return;
    }
    let cancelled = false;
    let task: ReturnType<PDFPageProxy['render']> | null = null;
    let layer: InstanceType<PdfLib['TextLayer']> | null = null;
    (async () => {
      const page = await doc.getPage(n);
      const viewport = page.getViewport({ scale: scale * CSS_UNITS, rotation: (page.rotate + rotation) % 360 });
      const ratio = Math.min(window.devicePixelRatio || 1, Math.sqrt(MAX_CANVAS_PIXELS / (viewport.width * viewport.height)));
      const canvas = document.createElement('canvas');
      canvas.width = Math.floor(viewport.width * ratio);
      canvas.height = Math.floor(viewport.height * ratio);
      task = page.render({ canvas, viewport, transform: ratio !== 1 ? [ratio, 0, 0, ratio, 0, 0] : undefined });
      await task.promise;
      if (cancelled) return;
      // Swap in only when drawn, so zooming never flashes a blank page.
      const old = canvasHolder.current?.querySelector('canvas');
      canvasHolder.current?.replaceChildren(canvas);
      if (old) {
        old.width = 0;
        old.height = 0;
      }
      setDrawn(true);

      const holder = textHolder.current;
      if (!holder) return;
      const text = await textOf(n);
      if (cancelled) return;
      const div = document.createElement('div');
      div.className = 'textLayer';
      layer = new pdf.TextLayer({ textContentSource: text.content, container: div, viewport });
      await layer.render();
      if (cancelled) return;
      holder.replaceChildren(div);
      onLayer(n, layer.textDivs);

      const annots = (await page.getAnnotations({ intent: 'display' })) as Array<{ subtype: string; rect: number[]; url?: string; unsafeUrl?: string; dest?: unknown }>;
      if (cancelled) return;
      setLinks(
        annots
          .filter((a) => a.subtype === 'Link' && (a.url || a.dest))
          .map((a) => {
            const [x1, y1] = viewport.convertToViewportPoint(a.rect[0], a.rect[1]) as number[];
            const [x2, y2] = viewport.convertToViewportPoint(a.rect[2], a.rect[3]) as number[];
            return {
              left: (Math.min(x1, x2) / viewport.width) * 100,
              top: (Math.min(y1, y2) / viewport.height) * 100,
              width: (Math.abs(x2 - x1) / viewport.width) * 100,
              height: (Math.abs(y2 - y1) / viewport.height) * 100,
              url: a.url && /^(https?:|mailto:)/i.test(a.url) ? a.url : undefined,
              dest: a.dest,
            };
          })
          .filter((l) => l.url || l.dest),
      );
    })().catch((err) => {
      if (!isCancel(err)) console.warn(`PDF page ${n} failed to render`, err);
    });
    return () => {
      cancelled = true;
      task?.cancel();
      layer?.cancel();
    };
  }, [near, scale, rotation, doc, n, pdf, textOf, onLayer]);

  return (
    <div
      ref={ref}
      className="lc-fv-pdf-page"
      data-page={n}
      style={{ top, width, height, left: `max(${GAP}px, calc(50% - ${width / 2}px))`, ['--total-scale-factor' as string]: scale * CSS_UNITS, ['--scale-round-x' as string]: '1px', ['--scale-round-y' as string]: '1px' }}
    >
      <div ref={canvasHolder} className="lc-fv-pdf-canvas" />
      <div ref={textHolder} className="lc-fv-pdf-text" />
      <div className="lc-fv-pdf-links">
        {links.map((l, i) =>
          l.url ? (
            <a key={i} href={l.url} target="_blank" rel="noopener noreferrer" title={l.url} style={{ left: `${l.left}%`, top: `${l.top}%`, width: `${l.width}%`, height: `${l.height}%` }} />
          ) : (
            <button key={i} type="button" title="Go to linked page" onClick={() => onDest(l.dest)} style={{ left: `${l.left}%`, top: `${l.top}%`, width: `${l.width}%`, height: `${l.height}%` }} />
          ),
        )}
      </div>
      {!drawn && <span className="lc-fv-pdf-pending">{n}</span>}
    </div>
  );
}

function Thumbnails({ doc, sizes, rotation, current, onPick }: { doc: PDFDocumentProxy; sizes: Array<{ w: number; h: number }>; rotation: number; current: number; onPick: (n: number) => void }) {
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => {
    list.current?.querySelector(`[data-thumb="${current}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [current]);
  return (
    <div className="lc-fv-thumbs" ref={list}>
      {sizes.map((s, i) => (
        <Thumb key={i} doc={doc} n={i + 1} size={s} rotation={rotation} active={current === i + 1} onPick={onPick} root={list} />
      ))}
    </div>
  );
}

function Thumb({ doc, n, size, rotation, active, onPick, root }: { doc: PDFDocumentProxy; n: number; size: { w: number; h: number }; rotation: number; active: boolean; onPick: (n: number) => void; root: RefObject<HTMLDivElement | null> }) {
  const ref = useRef<HTMLButtonElement>(null);
  const holder = useRef<HTMLSpanElement>(null);
  const [near, setNear] = useState(false);
  const turned = rotation % 180 !== 0;
  const w = 112;
  const h = Math.round(w * ((turned ? size.w : size.h) / (turned ? size.h : size.w)));
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(([e]) => e.isIntersecting && setNear(true), { root: root.current, rootMargin: '300px 0px' });
    io.observe(el);
    return () => io.disconnect();
  }, [root]);
  useEffect(() => {
    if (!near) return;
    let cancelled = false;
    let task: ReturnType<PDFPageProxy['render']> | null = null;
    (async () => {
      const page = await doc.getPage(n);
      const base = page.getViewport({ scale: 1, rotation: (page.rotate + rotation) % 360 });
      const viewport = page.getViewport({ scale: (w * Math.min(2, window.devicePixelRatio || 1)) / base.width, rotation: (page.rotate + rotation) % 360 });
      const canvas = document.createElement('canvas');
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      task = page.render({ canvas, viewport });
      await task.promise;
      if (!cancelled) holder.current?.replaceChildren(canvas);
    })().catch(() => undefined);
    return () => {
      cancelled = true;
      task?.cancel();
    };
  }, [near, doc, n, rotation]);
  return (
    <button ref={ref} type="button" className={`lc-fv-thumb${active ? ' is-active' : ''}`} data-thumb={n} onClick={() => onPick(n)} aria-label={`Page ${n}`} aria-current={active ? 'page' : undefined}>
      <span ref={holder} style={{ width: w, height: h }} />
      <span className="lc-fv-thumb-no">{n}</span>
    </button>
  );
}

function Outline({ nodes, onPick, depth = 0 }: { nodes: OutlineNode[]; onPick: (dest: unknown) => void; depth?: number }) {
  return (
    <ul className="lc-fv-outline" style={{ paddingLeft: depth ? 12 : 0 }}>
      {nodes.map((o, i) => (
        <OutlineItem key={i} node={o} onPick={onPick} depth={depth} />
      ))}
    </ul>
  );
}

function OutlineItem({ node, onPick, depth }: { node: OutlineNode; onPick: (dest: unknown) => void; depth: number }) {
  const [open, setOpen] = useState(depth < 1);
  return (
    <li>
      <span className="lc-fv-outline-row">
        {node.items.length ? (
          <button type="button" className="lc-fv-outline-toggle" onClick={() => setOpen((v) => !v)} aria-label={open ? 'Collapse' : 'Expand'}>
            <Icon name={open ? 'expand_more' : 'chevron_right'} size={16} />
          </button>
        ) : (
          <span className="lc-fv-outline-toggle" />
        )}
        {node.url ? (
          <a href={node.url} target="_blank" rel="noopener noreferrer">
            {node.title}
          </a>
        ) : (
          <button type="button" onClick={() => onPick(node.dest)}>
            {node.title}
          </button>
        )}
      </span>
      {open && node.items.length > 0 && <Outline nodes={node.items} onPick={onPick} depth={depth + 1} />}
    </li>
  );
}

function Properties({ doc, pdf, file, sizes, onClose }: { doc: PDFDocumentProxy; pdf: PdfLib; file: ViewerProps['file']; sizes: Array<{ w: number; h: number }>; onClose: () => void }) {
  const [info, setInfo] = useState<Record<string, unknown> | null>(null);
  useEffect(() => {
    doc.getMetadata().then((m) => setInfo((m.info as Record<string, unknown>) ?? {}), () => setInfo({}));
  }, [doc]);
  const date = (v: unknown) => {
    const d = typeof v === 'string' ? pdf.PDFDateString.toDateObject(v) : null;
    return d ? d.toLocaleString() : null;
  };
  const first = sizes[0];
  const paper = first ? `${(first.w / 72).toFixed(2)} × ${(first.h / 72).toFixed(2)} in (${Math.round((first.w / 72) * 25.4)} × ${Math.round((first.h / 72) * 25.4)} mm)` : null;
  const rows: Array<[string, unknown]> = info
    ? [
        ['Title', info.Title],
        ['Author', info.Author],
        ['Subject', info.Subject],
        ['Keywords', info.Keywords],
        ['Created', date(info.CreationDate)],
        ['Modified', date(info.ModDate)],
        ['Application', info.Creator],
        ['PDF producer', info.Producer],
        ['PDF version', info.PDFFormatVersion],
        ['Pages', doc.numPages],
        ['Page size', paper],
        ['Fillable form', info.IsAcroFormPresent ? 'Yes' : null],
        ['Fast web view', info.IsLinearized ? 'Yes' : 'No'],
        ['File', file.name],
      ]
    : [];
  return (
    <aside className="lc-fv-props" aria-label="Document properties">
      <div className="lc-fv-props-head">
        <strong>Properties</strong>
        <ToolButton icon="close" title="Close" onClick={onClose} />
      </div>
      {!info ? (
        <span className="lc-muted">Reading…</span>
      ) : (
        <dl>
          {rows
            .filter(([, v]) => v !== null && v !== undefined && v !== '')
            .map(([k, v]) => (
              <div key={k}>
                <dt>{k}</dt>
                <dd>{String(v)}</dd>
              </div>
            ))}
        </dl>
      )}
    </aside>
  );
}

function PasswordPrompt({ wrong, onSubmit }: { wrong: boolean; onSubmit: (pw: string) => void }) {
  const [pw, setPw] = useState('');
  return (
    <div className="lc-fv-notice">
      <Icon name="lock" size={32} />
      <strong>This PDF is password-protected</strong>
      <form
        className="lc-row"
        style={{ gap: 8 }}
        onSubmit={(e) => {
          e.preventDefault();
          if (pw) onSubmit(pw);
        }}
      >
        <input className="lc-input" type="password" autoFocus value={pw} onChange={(e) => setPw(e.target.value)} placeholder="Password" aria-label="PDF password" autoComplete="off" />
        <button type="submit" className="lc-btn lc-btn--primary lc-btn--sm">
          Open
        </button>
      </form>
      {wrong && <span className="lc-danger-text">That password isn’t right. Try again.</span>}
      <span className="lc-muted">The password is only used in your browser to open the file.</span>
    </div>
  );
}
