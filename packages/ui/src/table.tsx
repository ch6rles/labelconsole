import Link from 'next/link';
import type { ReactNode } from 'react';
import { cx } from './primitives';

export type Column<T> = {
  key: string;
  header: ReactNode;
  /** CSS grid track, e.g. `220px` or `minmax(240px,1fr)`. */
  width: string;
  align?: 'right' | 'center';
  render: (row: T) => ReactNode;
};

type Props<T> = {
  columns: Column<T>[];
  rows?: T[];
  groups?: Array<{ label: string; rows: T[] }>;
  rowKey: (row: T) => string;
  rowHref?: (row: T) => string | undefined;
  selectedKey?: string | null;
  /** Horizontal scroll below this width, as in the design. */
  minWidth?: number;
  empty?: ReactNode;
  title?: ReactNode;
  total?: ReactNode[];
  gap?: number;
};

/**
 * The design's data table: CSS grid rows with an explicit column template,
 * mono uppercase headers, optional group bands and a horizontal scroll.
 * Rows with an href render as links so the whole table works without JS.
 */
export function DataTable<T>({ columns, rows, groups, rowKey, rowHref, selectedKey, minWidth = 960, empty, title, total, gap = 12 }: Props<T>) {
  const template = columns.map((c) => c.width).join(' ');
  const style = { gridTemplateColumns: template, gap };
  const allGroups = groups ?? [{ label: '', rows: rows ?? [] }];
  const count = allGroups.reduce((n, g) => n + g.rows.length, 0);

  const cell = (c: Column<T>, row: T) => (
    <span key={c.key} className={cx(c.align === 'right' && 'lc-cell-right')} style={{ minWidth: 0, textAlign: c.align }}>
      {c.render(row)}
    </span>
  );

  return (
    <div className="lc-table-wrap">
      {title && <div className="lc-table-title">{title}</div>}
      <div style={{ minWidth }}>
        <div className="lc-table-grid lc-table-head" style={style}>
          {columns.map((c) => (
            <span key={c.key} style={{ textAlign: c.align }}>
              {c.header}
            </span>
          ))}
        </div>
        {allGroups.map((g, gi) => (
          <div key={gi}>
            {g.label && g.rows.length > 0 && <div className="lc-table-group">{g.label}</div>}
            {g.rows.map((row) => {
              const key = rowKey(row);
              const href = rowHref?.(row);
              const cls = cx('lc-table-grid lc-table-row', selectedKey === key && 'is-selected');
              return href ? (
                <Link key={key} href={href} className={cls} style={style} scroll={false}>
                  {columns.map((c) => cell(c, row))}
                </Link>
              ) : (
                <div key={key} className={cls} style={style}>
                  {columns.map((c) => cell(c, row))}
                </div>
              );
            })}
          </div>
        ))}
        {count === 0 && <div className="lc-table-empty">{empty ?? 'Nothing here yet.'}</div>}
        {total && count > 0 && (
          <div className="lc-table-grid lc-table-total" style={style}>
            {total.map((t, i) => (
              <span key={i} style={{ textAlign: columns[i]?.align }}>
                {t}
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/** Small helpers for common cell shapes. */
export function CellStack({ title, sub, mono }: { title: ReactNode; sub?: ReactNode; mono?: boolean }) {
  return (
    <span className="lc-cell-stack">
      <span className="lc-cell-strong lc-ellipsis">{title}</span>
      {sub && <span className={cx('lc-cell-sub lc-ellipsis', mono && 'lc-mono')}>{sub}</span>}
    </span>
  );
}

export function Num({ children, muted, strong, tone }: { children: ReactNode; muted?: boolean; strong?: boolean; tone?: 'red' | 'accent' }) {
  return (
    <span
      className="lc-cell-num"
      style={{
        color: tone === 'red' ? 'var(--lc-danger-fg)' : tone === 'accent' ? 'var(--lc-accent-fg)' : muted ? 'var(--lc-muted)' : undefined,
        fontWeight: strong ? 500 : undefined,
      }}
    >
      {children}
    </span>
  );
}
