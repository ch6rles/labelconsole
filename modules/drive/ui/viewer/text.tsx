'use client';

import { useMemo, useRef, useState } from 'react';
import { Markdown } from '@labelconsole/ui';
import { extensionOf } from '../../kinds';
import { highlightLines, langFor, type Lang } from './highlight';
import { Divider, FindBox, Segmented, Spacer, ToolButton, Toolbar, clamp, toggleFullscreen, useCopy, useFind, usePref, type ViewerProps } from './shared';

type Mode = 'source' | 'rendered' | 'formatted';
const CHUNK = 400;
/** Above this, colouring every token costs more than it helps. */
const HIGHLIGHT_LIMIT = 400_000;

const LANG_LABEL: Record<Lang, string> = {
  js: 'JavaScript / TypeScript', json: 'JSON', css: 'CSS', python: 'Python', ruby: 'Ruby', shell: 'Shell', sql: 'SQL', yaml: 'YAML', toml: 'TOML', ini: 'INI',
  xml: 'HTML / XML', markdown: 'Markdown', c: 'C-family', go: 'Go', rust: 'Rust', php: 'PHP', plain: 'Plain text',
};

/**
 * Text, code, Markdown and web pages: Markdown and HTML shown rendered or as
 * source, JSON formatted; source with line numbers, colouring, wrapping,
 * adjustable size, search and copy.
 */
export function TextViewer({ file, compact, preview }: ViewerProps & { preview: { text: string; truncated: boolean; encoding: string } }) {
  const ext = extensionOf(file.name);
  const lang: Lang = file.kind === 'markdown' ? 'markdown' : file.kind === 'html' ? 'xml' : langFor(ext);
  const formatted = useMemo(() => {
    if (lang !== 'json' || preview.truncated) return null;
    try {
      return JSON.stringify(JSON.parse(preview.text), null, 2);
    } catch {
      return null;
    }
  }, [lang, preview.text, preview.truncated]);
  const modes: Array<{ value: Mode; label: string; icon: string }> =
    file.kind === 'markdown' || file.kind === 'html'
      ? [
          { value: 'rendered', label: file.kind === 'html' ? 'Page' : 'Preview', icon: 'visibility' },
          { value: 'source', label: 'Source', icon: 'code' },
        ]
      : formatted
        ? [
            { value: 'formatted', label: 'Formatted', icon: 'data_object' },
            { value: 'source', label: 'Raw', icon: 'code' },
          ]
        : [];
  const [mode, setMode] = useState<Mode>(modes[0]?.value ?? 'source');
  const [wrap, setWrap] = usePref('wrap', true);
  const [numbers, setNumbers] = usePref('line-numbers', true);
  const [size, setSize] = usePref('font-size', 13);
  const [query, setQuery] = useState('');
  const body = useRef<HTMLDivElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const { copied, copy } = useCopy();

  const shown = mode === 'formatted' && formatted ? formatted : preview.text;
  const findable = !(mode === 'rendered' && file.kind === 'html');
  const find = useFind(() => (findable ? body.current : null), findable ? query : '', `${mode}`);
  const lines = useMemo(() => shown.replace(/\r\n?/g, '\n').split('\n'), [shown]);
  const words = useMemo(() => (file.kind === 'markdown' || file.kind === 'text' ? preview.text.split(/\s+/).filter(Boolean).length : null), [file.kind, preview.text]);

  return (
    <div className="lc-fv lc-fv-text" ref={stage}>
      <Toolbar>
        {modes.length > 0 && <Segmented label="View" value={mode} options={modes} onChange={setMode} />}
        {mode !== 'rendered' && (
          <>
            {modes.length > 0 && <Divider />}
            <ToolButton icon="wrap_text" title="Wrap long lines" onClick={() => setWrap(!wrap)} active={wrap} />
            <ToolButton icon="format_list_numbered" title="Line numbers" onClick={() => setNumbers(!numbers)} active={numbers} />
          </>
        )}
        <ToolButton icon="text_decrease" title="Smaller text" onClick={() => setSize(clamp(size - 1, 10, 24))} />
        <ToolButton icon="text_increase" title="Larger text" onClick={() => setSize(clamp(size + 1, 10, 24))} />
        <Spacer />
        {findable && <FindBox query={query} onQuery={setQuery} count={find.count} current={find.current} onNext={find.next} onPrev={find.prev} capped={find.capped} />}
        <ToolButton icon={copied ? 'check' : 'content_copy'} title={copied ? 'Copied' : preview.truncated ? 'Copy the part shown' : 'Copy all'} onClick={() => copy(shown)} />
        {!compact && <ToolButton icon="fullscreen" title="Full screen" onClick={() => toggleFullscreen(stage.current)} />}
      </Toolbar>
      {preview.truncated && <div className="lc-fv-banner">Showing the first 1 MB of this file. Download it to see all of it.</div>}
      <div className="lc-fv-stage lc-fv-scroll" style={{ ['--fv-font' as string]: `${size}px` }}>
        {mode === 'rendered' && file.kind === 'markdown' ? (
          <div ref={body} className="lc-fv-doc">
            <Markdown text={preview.text} />
          </div>
        ) : mode === 'rendered' && file.kind === 'html' ? (
          <HtmlFrame html={preview.text} title={file.name} />
        ) : (
          <div ref={body}>
            <SourceView lines={lines} lang={shown.length > HIGHLIGHT_LIMIT ? 'plain' : mode === 'formatted' ? 'json' : lang} wrap={wrap} numbers={numbers} />
          </div>
        )}
      </div>
      <div className="lc-fv-status">
        <span>{lines.length.toLocaleString()} lines</span>
        {words !== null && <span>{words.toLocaleString()} words</span>}
        <span>{LANG_LABEL[mode === 'formatted' ? 'json' : lang]}</span>
        <span>{preview.encoding}</span>
      </div>
    </div>
  );
}

/** Lines with numbers and colour, in blocks the browser lays out only when scrolled to. */
function SourceView({ lines, lang, wrap, numbers }: { lines: string[]; lang: Lang; wrap: boolean; numbers: boolean }) {
  const tokens = useMemo(() => highlightLines(lines, lang), [lines, lang]);
  const chunks = useMemo(() => {
    const out: number[] = [];
    for (let i = 0; i < tokens.length; i += CHUNK) out.push(i);
    return out;
  }, [tokens.length]);
  const digits = String(lines.length).length;
  return (
    <div className={`lc-fv-code${wrap ? ' is-wrap' : ''}${numbers ? ' has-numbers' : ''}`} style={{ ['--fv-gutter' as string]: `${digits + 1}ch` }}>
      {chunks.map((start) => (
        <div key={start} className="lc-fv-chunk" style={{ containIntrinsicSize: `auto ${Math.min(CHUNK, tokens.length - start) * 1.6}em` }}>
          {tokens.slice(start, start + CHUNK).map((line, k) => (
            <div key={k} className="lc-fv-line">
              {numbers && (
                <span className="lc-fv-ln" data-find-skip aria-hidden>
                  {start + k + 1}
                </span>
              )}
              <span className="lc-fv-lc">
                {line.length === 1 && !line[0].type
                  ? line[0].text || '​'
                  : line.map((t, j) =>
                      t.type ? (
                        <span key={j} className={`tk-${t.type}`}>
                          {t.text}
                        </span>
                      ) : (
                        t.text
                      ),
                    )}
                {line.length === 0 && '​'}
              </span>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

/** An HTML file drawn as a page in a sealed frame: no scripts, no requests, no access to the app. */
export function HtmlFrame({ html, title, zoom = 1 }: { html: string; title: string; zoom?: number }) {
  const doc = useMemo(
    () =>
      `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:"><base target="_blank"><style>html{zoom:${zoom}}body{font-family:system-ui,sans-serif;margin:16px;color:#0f172a;background:#fff}img{max-width:100%}</style>${html}`,
    [html, zoom],
  );
  return <iframe className="lc-fv-frame" title={title} sandbox="allow-popups allow-popups-to-escape-sandbox" srcDoc={doc} referrerPolicy="no-referrer" />;
}
