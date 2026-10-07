'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from '@labelconsole/ui';
import { FindBox, Spacer, ToolButton, Toolbar, clamp, toggleFullscreen, useFind, usePref, type ViewerProps } from './shared';

const DOC_CSS = `
html{background:#eef1f5}
body{margin:0;padding:24px 12px;font:15px/1.6 Calibri,Carlito,'Segoe UI',system-ui,sans-serif;color:#111827}
.page{background:#fff;max-width:816px;margin:0 auto;padding:72px 84px;box-shadow:0 1px 3px rgba(15,23,42,.14);box-sizing:border-box;min-height:1056px;overflow-wrap:break-word}
@media (max-width:720px){body{padding:0}.page{padding:24px 18px;min-height:0;box-shadow:none}}
h1,h2,h3,h4,h5,h6{line-height:1.25;margin:1.2em 0 .5em}h1{font-size:1.9em}h2{font-size:1.5em}h3{font-size:1.25em}
p{margin:0 0 .75em}ul,ol{margin:0 0 .75em;padding-left:1.6em}
table{border-collapse:collapse;width:100%;margin:1em 0;font-size:.95em}td,th{border:1px solid #cbd5e1;padding:6px 8px;vertical-align:top;text-align:left}th{background:#f8fafc}
img{max-width:100%;height:auto}a{color:#1d4ed8}blockquote{margin:0 0 .75em;padding-left:1em;border-left:3px solid #cbd5e1;color:#475569}
::highlight(lc-find){background:#fde68a;color:inherit}::highlight(lc-find-current){background:#f59e0b;color:#000}
@media print{html{background:#fff}body{padding:0}.page{box-shadow:none;max-width:none;padding:0;min-height:0}}
`;

type Heading = { level: number; text: string; id: string };

/**
 * Word documents, converted to HTML on the server and shown as a page in a
 * frame that runs no scripts and loads nothing from outside. Outline from the
 * headings, search, zoom, word count and print.
 */
export function DocumentViewer({ file, compact, html }: ViewerProps & { html: string }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const root = useRef<HTMLDivElement>(null);
  const [zoom, setZoom] = usePref('doc-zoom', 1);
  const [loaded, setLoaded] = useState(0);
  const [headings, setHeadings] = useState<Heading[]>([]);
  const [words, setWords] = useState(0);
  const [showOutline, setShowOutline] = useState(!compact);
  const [query, setQuery] = useState('');
  const find = useFind(() => frame.current?.contentDocument?.body, query, loaded);

  const srcDoc = useMemo(
    () =>
      `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'"><base target="_blank"><style>${DOC_CSS}</style></head><body><article class="page">${html || '<p style="color:#64748b">This document has no text.</p>'}</article></body></html>`,
    [html],
  );

  const onLoad = () => {
    const doc = frame.current?.contentDocument;
    if (!doc) return;
    const list: Heading[] = [];
    doc.querySelectorAll('h1, h2, h3, h4').forEach((h, i) => {
      const text = h.textContent?.trim();
      if (!text) return;
      h.id ||= `h-${i}`;
      list.push({ level: Number(h.tagName[1]), text, id: h.id });
    });
    setHeadings(list);
    setWords((doc.body.textContent ?? '').split(/\s+/).filter(Boolean).length);
    setLoaded((v) => v + 1);
  };

  useEffect(() => {
    const el = frame.current?.contentDocument?.documentElement;
    if (el) el.style.zoom = String(zoom);
  }, [zoom, loaded]);

  const jump = (id: string) => frame.current?.contentDocument?.getElementById(id)?.scrollIntoView({ block: 'start' });

  return (
    <div className="lc-fv lc-fv-document" ref={root}>
      <Toolbar>
        {!compact && <ToolButton icon="toc" title="Outline" onClick={() => setShowOutline(!showOutline)} active={showOutline && headings.length > 0} disabled={!headings.length} />}
        <ToolButton icon="zoom_out" title="Zoom out" onClick={() => setZoom(clamp(Math.round((zoom - 0.1) * 10) / 10, 0.5, 2.5))} />
        <button type="button" className="lc-fv-zoom" onClick={() => setZoom(1)} title="Reset zoom">
          {Math.round(zoom * 100)}%
        </button>
        <ToolButton icon="zoom_in" title="Zoom in" onClick={() => setZoom(clamp(Math.round((zoom + 0.1) * 10) / 10, 0.5, 2.5))} />
        <Spacer />
        <FindBox query={query} onQuery={setQuery} count={find.count} current={find.current} onNext={find.next} onPrev={find.prev} capped={find.capped} placeholder="Find in document" />
        <ToolButton icon="print" title="Print" onClick={() => frame.current?.contentWindow?.print()} />
        {!compact && <ToolButton icon="fullscreen" title="Full screen" onClick={() => toggleFullscreen(root.current)} />}
      </Toolbar>
      <div className="lc-fv-body">
        {showOutline && !compact && headings.length > 0 && (
          <aside className="lc-fv-side">
            <div className="lc-fv-side-title">Outline</div>
            <ul className="lc-fv-outline">
              {headings.map((h) => (
                <li key={h.id} style={{ paddingLeft: (h.level - 1) * 12 }}>
                  <span className="lc-fv-outline-row">
                    <button type="button" onClick={() => jump(h.id)}>
                      {h.text}
                    </button>
                  </span>
                </li>
              ))}
            </ul>
          </aside>
        )}
        <div className="lc-fv-stage">
          {/* Same-origin so search and the outline can reach the text; no scripts can run in it. */}
          <iframe ref={frame} className="lc-fv-frame" title={file.name} sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox allow-modals" srcDoc={srcDoc} onLoad={onLoad} referrerPolicy="no-referrer" />
        </div>
      </div>
      <div className="lc-fv-status">
        <span>
          <Icon name="description" size={14} /> {words.toLocaleString()} words
        </span>
        {headings.length > 0 && <span>{headings.length} headings</span>}
        <span className="lc-muted">Layout is simplified: open in Word for exact page breaks, headers and footers.</span>
      </div>
    </div>
  );
}
