import type { ReactNode } from 'react';

/**
 * Renders the Markdown agents write (headings, paragraphs, lists, tables,
 * quotes, code, bold, italic, links) as React elements. It never produces
 * raw HTML, so model output can't inject markup, and links are limited to
 * http(s), mailto and paths inside the console.
 */
export function Markdown({ text, className }: { text: string; className?: string }) {
  return <div className={className ? `lc-md ${className}` : 'lc-md'}>{blocks(text.replace(/\r\n?/g, '\n'))}</div>;
}

/** One line of plain text from Markdown, for previews in lists and table cells. */
export function markdownPreview(text: string, max = 200) {
  const plain = text
    .split('\n')
    .map((l) => l.trim())
    // Headings, rules and table separators say nothing on their own.
    .filter((l) => l && !/^#{1,6}\s/.test(l) && !/^(-{3,}|\*{3,}|_{3,})$/.test(l) && !/^\|?\s*:?-{3,}/.test(l))
    .map((l) =>
      l
        .replace(/^>\s?/, '')
        .replace(/^([-*+]|\d+[.)])\s+/, '')
        .replace(/\\\|/g, '\u0000')
        .replace(/^\||\|$/g, '')
        .replace(/\s*\|\s*/g, ' · ')
        .replace(/\u0000/g, '|')
        .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
        .replace(/(\*\*|__|~~|`)/g, '')
        .replace(/(^|[^\w*])\*([^*\s][^*]*?)\*/g, '$1$2')
        .trim(),
    )
    .join(' ')
    .replace(/\s+/g, ' ');
  return plain.length > max ? `${plain.slice(0, max - 1).replace(/[\uD800-\uDBFF]$/, '')}…` : plain;
}

const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const RULE = /^\s*(-{3,}|\*{3,}|_{3,})\s*$/;
const FENCE = /^\s*(```|~~~)/;
const LIST_ITEM = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
const TABLE_SEP = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;
const isTableRow = (l: string) => /^\s*\|.*\|\s*$/.test(l) || (l.includes('|') && l.trim().startsWith('|'));

function blocks(src: string): ReactNode[] {
  const lines = src.split('\n');
  const out: ReactNode[] = [];
  let i = 0;
  const key = () => `b${out.length}`;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }
    if (FENCE.test(line)) {
      const fence = line.trim().slice(0, 3);
      const code: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith(fence)) code.push(lines[i++]);
      i++;
      out.push(
        <pre key={key()} className="lc-md-pre">
          <code>{code.join('\n')}</code>
        </pre>,
      );
      continue;
    }
    const h = line.match(HEADING);
    if (h) {
      const level = h[1].length;
      const content = inline(h[2], key());
      out.push(level <= 2 ? <h3 key={key()} className="lc-md-h1">{content}</h3> : level === 3 ? <h4 key={key()} className="lc-md-h2">{content}</h4> : <h5 key={key()} className="lc-md-h3">{content}</h5>);
      i++;
      continue;
    }
    if (RULE.test(line)) {
      out.push(<hr key={key()} className="lc-md-hr" />);
      i++;
      continue;
    }
    if (isTableRow(line) && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1]) && lines[i + 1].includes('-')) {
      const head = cells(line);
      const align = cells(lines[i + 1]).map((c) => (c.startsWith(':') && c.endsWith(':') ? 'center' : c.endsWith(':') ? 'right' : undefined));
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length && lines[i].trim() && lines[i].includes('|')) rows.push(cells(lines[i++]));
      const k = key();
      out.push(
        <div key={k} className="lc-md-table-wrap">
          <table className="lc-md-table">
            <thead>
              <tr>
                {head.map((c, n) => (
                  <th key={n} style={{ textAlign: align[n] }}>{inline(c, `${k}h${n}`)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, rn) => (
                <tr key={rn}>
                  {head.map((_, n) => (
                    <td key={n} style={{ textAlign: align[n] }}>{inline(r[n] ?? '', `${k}r${rn}c${n}`)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      continue;
    }
    if (/^\s*>/.test(line)) {
      const quote: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) quote.push(lines[i++].replace(/^\s*>\s?/, ''));
      out.push(<blockquote key={key()} className="lc-md-quote">{blocks(quote.join('\n'))}</blockquote>);
      continue;
    }
    if (LIST_ITEM.test(line)) {
      const items: string[] = [];
      const base = line.match(/^\s*/)![0].length;
      const ordered = /^\s*\d/.test(line);
      // A bullet list followed directly by a numbered one (or the reverse) is two lists.
      const sameKind = (l: string) => (l.match(/^\s*/)![0].length > base + 1 ? true : /^\s*\d/.test(l) === ordered);
      while (i < lines.length && ((LIST_ITEM.test(lines[i]) && sameKind(lines[i])) || (lines[i].trim() && !LIST_ITEM.test(lines[i]) && /^\s{2,}/.test(lines[i])))) items.push(lines[i++]);
      out.push(list(items, key()));
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && lines[i].trim() && !HEADING.test(lines[i]) && !RULE.test(lines[i]) && !FENCE.test(lines[i]) && !LIST_ITEM.test(lines[i]) && !/^\s*>/.test(lines[i]) && !(isTableRow(lines[i]) && TABLE_SEP.test(lines[i + 1] ?? ''))) para.push(lines[i++].trim());
    const k = key();
    out.push(
      <p key={k} className="lc-md-p">
        {para.flatMap((l, n) => (n ? [<br key={`${k}br${n}`} />, ...inline(l, `${k}l${n}`)] : inline(l, `${k}l${n}`)))}
      </p>,
    );
  }
  return out;
}

/** A list, with deeper-indented items nested under the item before them. */
function list(lines: string[], k: string): ReactNode {
  const base = (lines[0].match(/^\s*/)?.[0].length ?? 0);
  const ordered = /^\s*\d+[.)]\s/.test(lines[0]);
  const items: Array<{ text: string; children: string[] }> = [];
  for (const l of lines) {
    const m = l.match(LIST_ITEM);
    const indent = l.match(/^\s*/)?.[0].length ?? 0;
    if (m && indent <= base + 1) items.push({ text: m[3], children: [] });
    else if (items.length) items.at(-1)!.children.push(l);
  }
  const body = items.map((it, n) => (
    <li key={n}>
      {inline(it.text, `${k}i${n}`)}
      {it.children.some((c) => LIST_ITEM.test(c)) ? list(it.children.filter((c) => c.trim()), `${k}i${n}s`) : it.children.length ? <> {inline(it.children.map((c) => c.trim()).join(' '), `${k}i${n}c`)}</> : null}
    </li>
  ));
  const start = ordered ? Number(lines[0].match(/^\s*(\d+)/)?.[1] ?? 1) : undefined;
  return ordered ? (
    <ol key={k} className="lc-md-list" start={start !== 1 ? start : undefined}>
      {body}
    </ol>
  ) : (
    <ul key={k} className="lc-md-list">
      {body}
    </ul>
  );
}

/** Split a table row on pipes that aren't escaped (\|) or inside `code`. */
function cells(row: string): string[] {
  const s = row.trim().replace(/^\|/, '').replace(/\|$/, '');
  const out: string[] = [];
  let cur = '';
  let code = false;
  for (let n = 0; n < s.length; n++) {
    const ch = s[n];
    if (ch === '\\' && s[n + 1] === '|') {
      cur += '|';
      n++;
    } else if (ch === '`') {
      code = !code;
      cur += ch;
    } else if (ch === '|' && !code) {
      out.push(cur.trim());
      cur = '';
    } else cur += ch;
  }
  out.push(cur.trim());
  return out;
}

const INLINE =
  /(`+)([^`]+?)\1|\*\*(.+?)\*\*|__(.+?)__|~~(.+?)~~|\[([^\]]+)\]\(\s*<?([^)\s>]+)>?\s*\)|(?<![\w*])\*(?!\s)([^*]+?)\*(?![\w*])|(?<![\w_])_(?!\s)([^_]+?)_(?![\w_])|(https?:\/\/[^\s<>()[\]]+[^\s<>()[\].,;:!?'"*_])/g;

/** Only web, mail and in-console links; anything else (javascript:, data:) renders as text. */
function safeHref(url: string): string | null {
  if (/^https?:\/\//i.test(url) || /^mailto:/i.test(url)) return url;
  if (url.startsWith('/') && !url.startsWith('//')) return url;
  return null;
}

function inline(text: string, k: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let n = 0;
  for (const m of text.matchAll(INLINE)) {
    const at = m.index ?? 0;
    if (at > last) out.push(text.slice(last, at));
    const id = `${k}-${n++}`;
    if (m[2] !== undefined) out.push(<code key={id} className="lc-md-code">{m[2]}</code>);
    else if (m[3] !== undefined || m[4] !== undefined) out.push(<strong key={id}>{inline(m[3] ?? m[4], id)}</strong>);
    else if (m[5] !== undefined) out.push(<del key={id}>{inline(m[5], id)}</del>);
    else if (m[6] !== undefined) {
      const href = safeHref(m[7]);
      out.push(href ? <a key={id} href={href} {...(href.startsWith('/') ? {} : { target: '_blank', rel: 'noopener noreferrer' })}>{inline(m[6], id)}</a> : m[0]);
    } else if (m[8] !== undefined || m[9] !== undefined) out.push(<em key={id}>{inline(m[8] ?? m[9], id)}</em>);
    else if (m[10] !== undefined) out.push(<a key={id} href={m[10]} target="_blank" rel="noopener noreferrer">{m[10]}</a>);
    last = at + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}
