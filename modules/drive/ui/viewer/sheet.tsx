'use client';

import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { Icon } from '@labelconsole/ui';
import type { SheetPreview } from '../../preview';
import { columnName, numeric } from './inspect';
import { Spacer, ToolButton, Toolbar, toggleFullscreen, useCopy, type ViewerProps } from './shared';

type Cell = SheetPreview['rows'][number][number];
const ROW_H = 30;
const OVERSCAN = 12;

const isNum = (v: Cell) => numeric(v) !== null;
const show = (v: Cell) => (v === null || v === undefined ? '' : typeof v === 'boolean' ? (v ? 'TRUE' : 'FALSE') : typeof v === 'number' ? (Number.isInteger(v) ? String(v) : String(Math.round(v * 1e6) / 1e6)) : v);
const compare = (a: Cell, b: Cell) => {
  if (a === null || a === '') return b === null || b === '' ? 0 : 1;
  if (b === null || b === '') return -1;
  const na = numeric(a);
  const nb = numeric(b);
  if (na !== null && nb !== null) return na - nb;
  return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' });
};

/** Whether the first row reads as column names: all text, mostly filled, and not like the rows below it. */
function looksLikeHeader(rows: Cell[][]) {
  const [first, second] = rows;
  if (!first || !second) return false;
  const filled = first.filter((c) => c !== null && c !== '');
  return filled.length >= Math.max(1, first.length * 0.6) && filled.every((c) => typeof c === 'string' && c.length < 80) && second.some((c) => isNum(c));
}

/**
 * Spreadsheets (CSV, TSV, Excel): every sheet as a tab, a grid with column
 * letters and row numbers that scrolls smoothly through thousands of rows,
 * sort by any column, filter rows, a header-row switch, the selected cell's
 * full value and the selected column's count, sum and average, and the view
 * saved as CSV.
 */
export function SheetViewer({ file, compact, sheets }: ViewerProps & { sheets: SheetPreview[] }) {
  const [tab, setTab] = useState(0);
  const sheet = sheets[tab] ?? sheets[0];
  const [header, setHeader] = useState(() => looksLikeHeader(sheet?.rows ?? []));
  const [sort, setSort] = useState<{ col: number; dir: 1 | -1 } | null>(null);
  const [filter, setFilter] = useState('');
  const [sel, setSel] = useState<{ r: number; c: number } | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [height, setHeight] = useState(400);
  const scroller = useRef<HTMLDivElement>(null);
  const root = useRef<HTMLDivElement>(null);
  const { copied, copy } = useCopy();

  useEffect(() => {
    setHeader(looksLikeHeader(sheet?.rows ?? []));
    setSort(null);
    setSel(null);
    scroller.current?.scrollTo({ top: 0, left: 0 });
  }, [tab, sheet]);

  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setHeight(el.clientHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const cols = Math.max(1, Math.min(sheet?.totalCols ?? 0, 200));
  const head = header && sheet ? sheet.rows[0] : null;
  // Rows keep their original number (as in the spreadsheet) through sorting and filtering.
  const rows = useMemo(() => {
    if (!sheet) return [];
    let list = sheet.rows.map((cells, i) => ({ n: i + 1, cells })).slice(header ? 1 : 0);
    const q = filter.trim().toLowerCase();
    if (q) list = list.filter((r) => r.cells.some((c) => c !== null && String(show(c)).toLowerCase().includes(q)));
    if (sort) list = [...list].sort((a, b) => compare(a.cells[sort.col] ?? null, b.cells[sort.col] ?? null) * sort.dir);
    return list;
  }, [sheet, header, filter, sort]);

  const first = Math.max(0, Math.floor(scrollTop / ROW_H) - OVERSCAN);
  const last = Math.min(rows.length, Math.ceil((scrollTop + height) / ROW_H) + OVERSCAN);
  const visible = rows.slice(first, last);

  const stats = useMemo(() => {
    if (!sel) return null;
    let count = 0;
    let nums = 0;
    let sum = 0;
    let min = Infinity;
    let max = -Infinity;
    for (const r of rows) {
      const v = r.cells[sel.c];
      if (v === null || v === undefined || v === '') continue;
      count++;
      const n = numeric(v);
      if (n !== null) {
        nums++;
        sum += n;
        min = Math.min(min, n);
        max = Math.max(max, n);
      }
    }
    return { count, nums, sum, min, max };
  }, [rows, sel]);

  const toggleSort = (col: number) => setSort((s) => (s?.col !== col ? { col, dir: 1 } : s.dir === 1 ? { col, dir: -1 } : null));

  const selected = sel ? rows[sel.r] : null;
  const selectedValue = selected ? (selected.cells[sel!.c] ?? null) : null;

  const onKey = (e: KeyboardEvent) => {
    if (!sel) return;
    const move = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1], PageDown: [Math.floor(height / ROW_H), 0], PageUp: [-Math.floor(height / ROW_H), 0] }[e.key];
    if (move) {
      e.preventDefault();
      const r = Math.max(0, Math.min(rows.length - 1, sel.r + move[0]));
      const c = Math.max(0, Math.min(cols - 1, sel.c + move[1]));
      setSel({ r, c });
      const el = scroller.current;
      if (el) {
        const top = r * ROW_H;
        if (top < el.scrollTop) el.scrollTop = top;
        else if (top + ROW_H * 2 > el.scrollTop + el.clientHeight) el.scrollTop = top + ROW_H * 2 - el.clientHeight;
      }
    } else if ((e.ctrlKey || e.metaKey) && e.key === 'c' && selected) {
      e.preventDefault();
      void copy(String(show(selectedValue)));
    }
  };

  const toCsv = () => {
    const esc = (v: Cell) => {
      const s = String(show(v));
      return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const lines = [...(head ? [head] : []), ...rows.map((r) => r.cells)].map((r) => Array.from({ length: cols }, (_, i) => esc(r[i] ?? null)).join(','));
    const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${file.name.replace(/\.[^.]+$/, '')}${sheets.length > 1 ? ` - ${sheet.name}` : ''}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };

  if (!sheet) return <div className="lc-fv-notice"><Icon name="table" size={32} /><strong>This spreadsheet is empty</strong></div>;

  return (
    <div className="lc-fv lc-fv-sheet" ref={root}>
      <Toolbar>
        <span className="lc-fv-find">
          <Icon name="filter_list" size={16} />
          <input type="search" value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter rows" aria-label="Filter rows" />
          {filter && <span className="lc-fv-find-count">{rows.length.toLocaleString()}</span>}
        </span>
        <label className="lc-fv-check">
          <input type="checkbox" checked={header} onChange={(e) => setHeader(e.target.checked)} />
          First row is headings
        </label>
        {sort && <ToolButton icon="sort" label="Clear sort" title="Back to the file’s order" onClick={() => setSort(null)} />}
        <Spacer />
        <span className="lc-fv-meta">
          {sheet.totalRows.toLocaleString()} rows × {sheet.totalCols.toLocaleString()} columns
        </span>
        <ToolButton icon="download" title="Save this view as CSV" onClick={toCsv} />
        {!compact && <ToolButton icon="fullscreen" title="Full screen" onClick={() => toggleFullscreen(root.current)} />}
      </Toolbar>
      {sheet.truncated && <div className="lc-fv-banner">This sheet is large: showing the first {sheet.rows.length.toLocaleString()} rows and 200 columns. Download it for everything.</div>}
      <div className="lc-fv-cellbar">
        <span className="lc-fv-cellref">{sel && selected ? `${columnName(sel.c)}${selected.n}` : ''}</span>
        <span className="lc-fv-cellval" title={selectedValue === null ? undefined : String(show(selectedValue))}>
          {selectedValue === null ? <span className="lc-muted">{sel ? 'Empty cell' : 'Select a cell to see its full value'}</span> : String(show(selectedValue))}
        </span>
        {selected && selectedValue !== null && <ToolButton icon={copied ? 'check' : 'content_copy'} title="Copy value" onClick={() => copy(String(show(selectedValue)))} />}
      </div>
      <div className="lc-fv-stage lc-fv-grid-wrap" ref={scroller} onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)} tabIndex={0} onKeyDown={onKey} role="grid" aria-rowcount={rows.length} aria-colcount={cols}>
        <table className="lc-fv-grid">
          <thead>
            <tr>
              <th className="lc-fv-corner" />
              {Array.from({ length: cols }, (_, c) => (
                <th key={c} className={sel?.c === c ? 'is-sel' : undefined} aria-sort={sort?.col === c ? (sort.dir === 1 ? 'ascending' : 'descending') : undefined}>
                  <button type="button" onClick={() => toggleSort(c)} title={`Sort by ${head?.[c] ? String(head[c]) : `column ${columnName(c)}`}`}>
                    <span className="lc-fv-colname">{head ? String(show(head[c] ?? null)) || columnName(c) : columnName(c)}</span>
                    {sort?.col === c && <Icon name={sort.dir === 1 ? 'arrow_upward' : 'arrow_downward'} size={14} />}
                  </button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {first > 0 && (
              <tr aria-hidden style={{ height: first * ROW_H }}>
                <td colSpan={cols + 1} />
              </tr>
            )}
            {visible.map((r, k) => {
              const ri = first + k;
              return (
                <tr key={r.n} className={sel?.r === ri ? 'is-sel' : undefined}>
                  <th scope="row">{r.n}</th>
                  {Array.from({ length: cols }, (_, c) => {
                    const v = r.cells[c] ?? null;
                    return (
                      <td key={c} className={`${isNum(v) ? 'is-num' : ''}${sel?.r === ri && sel.c === c ? ' is-cur' : ''}`} onClick={() => setSel({ r: ri, c })}>
                        {show(v)}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
            {last < rows.length && (
              <tr aria-hidden style={{ height: (rows.length - last) * ROW_H }}>
                <td colSpan={cols + 1} />
              </tr>
            )}
          </tbody>
        </table>
        {rows.length === 0 && <div className="lc-fv-empty">{filter ? 'No rows match that filter' : 'No rows'}</div>}
      </div>
      <div className="lc-fv-status">
        {sheets.length > 1 && (
          <span className="lc-fv-sheet-tabs" role="tablist">
            {sheets.map((s, i) => (
              <button key={i} type="button" role="tab" aria-selected={i === tab} className={i === tab ? 'is-active' : undefined} onClick={() => setTab(i)}>
                {s.name}
              </button>
            ))}
          </span>
        )}
        <Spacer />
        {stats && sel && (
          <span className="lc-fv-stats">
            {head?.[sel.c] ? `${String(head[sel.c])}: ` : `Column ${columnName(sel.c)}: `}
            {stats.count.toLocaleString()} filled
            {stats.nums > 0 && ` · sum ${fmtNum(stats.sum)} · average ${fmtNum(stats.sum / stats.nums)} · min ${fmtNum(stats.min)} · max ${fmtNum(stats.max)}`}
          </span>
        )}
      </div>
    </div>
  );
}

const fmtNum = (n: number) => n.toLocaleString(undefined, { maximumFractionDigits: 2 });
