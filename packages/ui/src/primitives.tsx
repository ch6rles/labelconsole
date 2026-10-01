import Link from 'next/link';
import type { CSSProperties, ReactNode } from 'react';
import { initials as toInitials } from './format';

/* Server-safe primitives: no hooks, no handlers. Interactive pieces live in client.tsx. */

export function cx(...parts: Array<string | false | null | undefined>) {
  return parts.filter(Boolean).join(' ');
}

export function Icon({ name, size, className, style, title }: { name: string; size?: number; className?: string; style?: CSSProperties; title?: string }) {
  return (
    <span aria-hidden={title ? undefined : true} title={title} className={cx('lc-icon', className)} style={size ? { fontSize: size, ...style } : style}>
      {name}
    </span>
  );
}

export type Tone = 'blue' | 'red' | 'neutral' | 'ink' | 'muted' | 'solid' | 'outline-blue';

export function Chip({ tone = 'neutral', children, icon, title }: { tone?: Tone; children: ReactNode; icon?: string; title?: string }) {
  return (
    <span className={cx('lc-chip', tone !== 'neutral' && `lc-chip--${tone}`)} title={title}>
      {icon && <Icon name={icon} size={14} />}
      {children}
    </span>
  );
}

export function Tag({ children }: { children: ReactNode }) {
  return <span className="lc-tag">{children}</span>;
}

export function DateTag({ kind, children }: { kind: 'released' | 'upcoming' | 'tbd'; children: ReactNode }) {
  return <span className={cx('lc-date-tag', kind !== 'tbd' && `lc-date-tag--${kind}`)}>{children}</span>;
}

export function Avatar({ name, src, round, size }: { name: string; src?: string | null; round?: boolean; size?: 'lg' }) {
  return (
    <span className={cx('lc-avatar', round && 'lc-avatar--round', size === 'lg' && 'lc-avatar--lg')}>
      {src ? <img src={src} alt="" width="100%" height="100%" /> : toInitials(name)}
    </span>
  );
}

export function Cover({ src, empty, icon = 'music_note' }: { src?: string | null; empty?: boolean; icon?: string }) {
  return <span className={cx('lc-cover', empty && !src && 'lc-cover--empty')}>{src ? <img src={src} alt="" /> : !empty && <Icon name={icon} />}</span>;
}

export function Progress({ value, width = 56, tone = 'blue' }: { value: number; width?: number; tone?: 'blue' | 'red' | 'wait' }) {
  const v = Math.max(0, Math.min(100, value));
  return (
    <span className={cx('lc-progress', tone !== 'blue' && `lc-progress--${tone}`)} style={{ width }} role="progressbar" aria-valuenow={v} aria-valuemin={0} aria-valuemax={100}>
      <span style={{ width: `${v}%` }} />
    </span>
  );
}

export function Meter({ value }: { value: number }) {
  return (
    <div className="lc-meter">
      <div style={{ width: `${Math.max(0, Math.min(100, value))}%` }} />
    </div>
  );
}

export const SERIES = ['var(--lc-series-1)', 'var(--lc-series-2)', 'var(--lc-series-3)', 'var(--lc-series-4)'];

export function SplitBar({ parts }: { parts: Array<{ name: string; pct: number }> }) {
  return (
    <div className="lc-stack" style={{ gap: 8 }}>
      <div className="lc-split-bar">
        {parts.map((p, i) => (
          <span key={i} style={{ width: `${p.pct}%`, background: SERIES[i % SERIES.length] }} />
        ))}
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px 14px' }}>
        {parts.map((p, i) => (
          <span key={i} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--lc-text-2)' }}>
            <span className="lc-swatch" style={{ background: SERIES[i % SERIES.length] }} />
            {p.name} <span className="lc-mono lc-muted">{Number(p.pct.toFixed(2))}%</span>
          </span>
        ))}
      </div>
    </div>
  );
}

export function StepBoxes({ steps }: { steps: boolean[] }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: `repeat(${steps.length}, 1fr)`, justifyItems: 'center' }}>
      {steps.map((done, i) => (
        <span key={i} className={cx('lc-step-box', done && 'is-done')}>
          {done && <Icon name="check" />}
        </span>
      ))}
    </div>
  );
}

export function PageHeader({ title, description, actions, large }: { title: ReactNode; description?: ReactNode; actions?: ReactNode; large?: boolean }) {
  return (
    <div className="lc-page-head">
      <div className="lc-page-head-text">
        <h1 className={cx('lc-h1', large && 'lc-h1--lg')}>{title}</h1>
        {description && <p className={cx('lc-lede', large && 'lc-lede--lg')}>{description}</p>}
      </div>
      {actions && <div className="lc-page-actions">{actions}</div>}
    </div>
  );
}

export function Page({ children, variant }: { children: ReactNode; variant?: 'narrow' | 'dashboard' }) {
  return <div className={cx('lc-page', variant && `lc-page--${variant}`)}>{children}</div>;
}

export function Summary({ children }: { children: ReactNode }) {
  return <div className="lc-summary">{children}</div>;
}

export function Section({ title, aside, children }: { title?: ReactNode; aside?: ReactNode; children: ReactNode }) {
  return (
    <section className="lc-section">
      {(title || aside) && (
        <div className="lc-section-head">
          {title && <h2 className="lc-h2">{title}</h2>}
          {aside && <span className="lc-mono lc-muted" style={{ fontSize: 12, whiteSpace: 'nowrap' }}>{aside}</span>}
        </div>
      )}
      {children}
    </section>
  );
}

export function SectionLabel({ children }: { children: ReactNode }) {
  return <span className="lc-section-label">{children}</span>;
}

export function Card({ title, sub, actions, children, padded = true, className }: { title?: ReactNode; sub?: ReactNode; actions?: ReactNode; children?: ReactNode; padded?: boolean; className?: string }) {
  return (
    <section className={cx('lc-card', className)}>
      {(title || actions) && (
        <div className="lc-card-head">
          <div className="lc-card-head-text">
            {title && <span className="lc-card-title">{title}</span>}
            {sub && <span className="lc-card-sub">{sub}</span>}
          </div>
          {actions && <div className="lc-row">{actions}</div>}
        </div>
      )}
      {padded ? <div className="lc-card-body">{children}</div> : children}
    </section>
  );
}

export function StatCard({ label, icon, value, delta, deltaDown, note, href }: { label: string; icon?: string; value: ReactNode; delta?: string; deltaDown?: boolean; note?: ReactNode; href?: string }) {
  const body = (
    <>
      <div className="lc-stat-head">
        <span className="lc-stat-label">{label}</span>
        {icon && <Icon name={icon} />}
      </div>
      <span className="lc-stat-value">{value}</span>
      {(delta || note) && (
        <span className="lc-stat-note">
          {delta && <span className={cx('lc-stat-delta', deltaDown && 'is-down')}>{delta}</span>} {note}
        </span>
      )}
    </>
  );
  return href ? (
    <Link href={href} className="lc-stat">
      {body}
    </Link>
  ) : (
    <div className="lc-stat">{body}</div>
  );
}

export function KV({ k, v, tone, divided }: { k: ReactNode; v: ReactNode; tone?: 'red' | 'accent'; divided?: boolean }) {
  return (
    <div className={cx('lc-kv', divided && 'lc-kv--divided')}>
      <span className="lc-kv-k">{k}</span>
      <span className={cx('lc-kv-v', tone === 'red' && 'lc-danger-text', tone === 'accent' && 'lc-accent-text')}>{v}</span>
    </div>
  );
}

export function EmptyState({ icon = 'inbox', title, children, action }: { icon?: string; title: ReactNode; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="lc-empty">
      <Icon name={icon} />
      <span className="lc-empty-title">{title}</span>
      {children && <span style={{ maxWidth: 520, lineHeight: 1.5 }}>{children}</span>}
      {action}
    </div>
  );
}

export function Skeleton({ height = 14, width = '100%' }: { height?: number; width?: number | string }) {
  return <div className="lc-skeleton" style={{ height, width }} />;
}

export function Spinner() {
  return <span className="lc-spinner" role="status" aria-label="Loading" />;
}

export function InlineNote({ icon = 'info', children }: { icon?: string; children: ReactNode }) {
  return (
    <div className="lc-inline-note">
      <Icon name={icon} />
      <span>{children}</span>
    </div>
  );
}

export function Banner({ icon = 'info', warn, children }: { icon?: string; warn?: boolean; children: ReactNode }) {
  return (
    <div className={cx('lc-banner', warn && 'is-warn')}>
      <Icon name={icon} />
      <div>{children}</div>
    </div>
  );
}

export function LinkButton({ href, icon, children, variant, size, external }: { href: string; icon?: string; children?: ReactNode; variant?: 'primary' | 'ghost'; size?: 'sm' | 'xs'; external?: boolean }) {
  const cls = cx('lc-btn', variant && `lc-btn--${variant}`, size && `lc-btn--${size}`);
  const inner = (
    <>
      {icon && <Icon name={icon} />}
      {children}
    </>
  );
  return external ? (
    <a className={cls} href={href} target="_blank" rel="noreferrer">
      {inner}
    </a>
  ) : (
    <Link className={cls} href={href}>
      {inner}
    </Link>
  );
}

export type AttentionRow = { n: number | string; tone?: 'red' | 'ink' | 'accent'; title: ReactNode; sub?: ReactNode; href?: string; money?: string };

/** The design's "Needs attention" / marketing task rows. */
export function AttentionList({ rows, wide, empty }: { rows: AttentionRow[]; wide?: boolean; empty?: ReactNode }) {
  if (rows.length === 0 && empty) return <>{empty}</>;
  return (
    <div className="lc-list">
      {rows.map((r, i) => {
        const inner = (
          <>
            {wide ? (
              <span style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 2 }}>
                <span className={cx('lc-list-n', r.tone === 'red' && 'is-red', (r.tone ?? 'accent') === 'accent' && 'is-accent')}>{r.n}</span>
                {r.money && <span className="lc-mono lc-muted" style={{ fontSize: 11 }}>{r.money}</span>}
              </span>
            ) : (
              <span className={cx('lc-list-n', r.tone === 'red' && 'is-red', r.tone === 'accent' && 'is-accent')}>{r.n}</span>
            )}
            <span className="lc-list-text">
              <span className={wide ? 'lc-list-title lc-cell-strong' : 'lc-list-title'} style={wide ? { fontSize: 15 } : undefined}>
                {r.title}
              </span>
              {r.sub && <span className="lc-list-sub">{r.sub}</span>}
            </span>
            <Icon name="arrow_forward" className="is-arrow" />
          </>
        );
        return r.href ? (
          <Link key={i} href={r.href} className={cx('lc-list-row', wide && 'lc-list-row--wide')}>
            {inner}
          </Link>
        ) : (
          <div key={i} className={cx('lc-list-row', wide && 'lc-list-row--wide')} style={{ cursor: 'default' }}>
            {inner}
          </div>
        );
      })}
    </div>
  );
}

/** URL-driven filter pills (server-rendered links). */
export function FilterPills({ items }: { items: Array<{ label: string; count?: number; href: string; active: boolean }> }) {
  return (
    <div className="lc-row" style={{ gap: 6 }}>
      {items.map((f) => (
        <Link key={f.href} href={f.href} className={cx('lc-filter', f.active && 'is-active')} scroll={false}>
          {f.label}
          {f.count != null && <span className="lc-filter-count">{f.count}</span>}
        </Link>
      ))}
    </div>
  );
}

/** Secondary in-page tabs (e.g. on a detail page). */
export function SubTabs({ items }: { items: Array<{ label: string; href: string; active: boolean }> }) {
  return (
    <div className="lc-row" style={{ gap: 6 }}>
      {items.map((t) => (
        <Link key={t.href} href={t.href} className={cx('lc-tab', t.active && 'is-active')} scroll={false}>
          {t.label}
        </Link>
      ))}
    </div>
  );
}

export function Timeline({ items }: { items: Array<{ time: string; icon: string; who: ReactNode; what: ReactNode; area?: string }> }) {
  return (
    <div className="lc-list lc-timeline">
      {items.map((e, i) => (
        <div key={i} className="lc-timeline-item">
          <span className="lc-mono lc-muted" style={{ fontSize: 12 }}>{e.time}</span>
          <Icon name={e.icon} />
          <span>
            <span style={{ fontWeight: 500 }}>{e.who}</span> <span style={{ color: 'var(--lc-text-2)' }}>{e.what}</span>
          </span>
          {e.area && <span className="lc-tag" style={{ justifySelf: 'end' }}>{e.area}</span>}
        </div>
      ))}
    </div>
  );
}
