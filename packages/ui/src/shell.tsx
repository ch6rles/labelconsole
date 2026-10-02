'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { api, ToastProvider, useToast } from './client';
import { relative } from './format';
import { RealtimeContext, useDebouncedCallback, useHotkey, useOnClickOutside, usePersistedState, useRealtime, useRealtimeConnection } from './hooks';
import { cx, Icon, Spinner } from './primitives';

export type ShellTab = { id: string; label: string; href: string };
export type ShellSection = { id: string; label: string; icon: string; sub: string; tabs: ShellTab[] };
export type ShellWidget = { id: string; name: string; icon: string; desc: string; value: string; unit: string; line: string; cta: string; href: string };

export type ShellProps = {
  nav: ShellSection[];
  org: { id: string; name: string; shortCode: string; siteUrl?: string | null };
  orgs: Array<{ id: string; name: string; shortCode: string }>;
  user: { id: string; name: string; roleLabel: string };
  widgets: ShellWidget[];
  unread: number;
  runningAgents: number;
  pendingApprovals: number;
  /** False when the label doesn't have the Agents module; hides the agent indicator. */
  agentsEnabled?: boolean;
  children: ReactNode;
};

function matchActive(nav: ShellSection[], pathname: string) {
  let best: { section: ShellSection; tab: ShellTab | null; score: number } | null = null;
  for (const s of nav) {
    for (const t of s.tabs) {
      const hit = t.href === '/' ? pathname === '/' : pathname === t.href || pathname.startsWith(t.href + '/');
      if (hit && (!best || t.href.length > best.score)) best = { section: s, tab: t, score: t.href.length };
    }
  }
  return best;
}

/** The console layout: every module page renders inside this. */
export function ConsoleShell(props: ShellProps) {
  const bus = useRealtimeConnection();
  return (
    <RealtimeContext.Provider value={bus}>
      <ToastProvider>
        <ShellInner {...props} />
      </ToastProvider>
    </RealtimeContext.Provider>
  );
}

function ShellInner({ nav, org, orgs, user, widgets, unread, runningAgents, pendingApprovals, agentsEnabled = true, children }: ShellProps) {
  const pathname = usePathname();
  const [navOpen, setNavOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  useEffect(() => setNavOpen(false), [pathname]);
  useHotkey('mod+k', (e) => {
    e.preventDefault();
    setPaletteOpen((o) => !o);
  });

  const active = matchActive(nav, pathname);
  const section = active?.section;
  const tab = active?.tab;
  const title = section?.label ?? 'Label Console';
  const crumb = section && tab && section.tabs.length > 1 ? `${section.label} / ${tab.label}` : section?.label ?? '';

  return (
    <div className={cx('lc-app', navOpen && 'is-nav-open')}>
      {navOpen && <div className="lc-nav-backdrop" onClick={() => setNavOpen(false)} />}
      <Sidebar nav={nav} org={org} orgs={orgs} user={user} widgets={widgets} activeId={section?.id} />
      <main className="lc-main">
        <header className="lc-header">
          <div className="lc-header-row">
            <div className="lc-header-title">
              <button type="button" className="lc-icon-btn lc-menu-toggle" aria-label="Open navigation" onClick={() => setNavOpen(true)}>
                <Icon name="menu" />
              </button>
              <strong className="lc-ellipsis">{title}</strong>
              <span className="lc-vsep lc-hide-mobile" />
              <span className="lc-crumb">
                <Link href="/" aria-label="Dashboard" style={{ color: 'inherit', display: 'flex' }}>
                  <Icon name="home" />
                </Link>
                <Icon name="chevron_right" className="is-chevron" />
                <span>{crumb}</span>
              </span>
            </div>
            <div className="lc-header-actions">
              {org.siteUrl && (
                <a className="lc-btn lc-btn--sm lc-hide-mobile" href={org.siteUrl.startsWith('http') ? org.siteUrl : `https://${org.siteUrl}`} target="_blank" rel="noreferrer">
                  <Icon name="open_in_new" size={16} />
                  View site
                </a>
              )}
              {agentsEnabled && <AgentIndicator initialRunning={runningAgents} pendingApprovals={pendingApprovals} />}
              <NotificationsTray userId={user.id} initialUnread={unread} />
              <button type="button" className="lc-search-trigger" onClick={() => setPaletteOpen(true)} aria-label="Search">
                <Icon name="search" />
                <span className="lc-search-trigger-text">Search…</span>
                <span className="lc-kbd">Ctrl K</span>
              </button>
            </div>
          </div>
          {section && section.tabs.length > 1 && (
            <nav className="lc-tabs" aria-label={`${section.label} sections`}>
              {section.tabs.map((t) => (
                <Link key={t.id} href={t.href} className={cx('lc-tab', t.id === tab?.id && 'is-active')}>
                  {t.label}
                </Link>
              ))}
            </nav>
          )}
        </header>
        {children}
      </main>
      {paletteOpen && <CommandPalette nav={nav} onClose={() => setPaletteOpen(false)} />}
    </div>
  );
}

function Sidebar({ nav, org, orgs, user, widgets, activeId }: { nav: ShellSection[]; org: ShellProps['org']; orgs: ShellProps['orgs']; user: ShellProps['user']; widgets: ShellWidget[]; activeId?: string }) {
  const [pinned, setPinned] = usePersistedState<string[]>(`labelconsole.pinned.${org.id}`, widgets.slice(0, 3).map((w) => w.id));
  const [pickerOpen, setPickerOpen] = useState(false);
  const [showSwitcher, setShowSwitcher] = useState(false);
  const toggle = (id: string) => setPinned((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));
  const shown = pinned.map((id) => widgets.find((w) => w.id === id)).filter((w): w is ShellWidget => Boolean(w));

  return (
    <aside className="lc-sidebar">
      <div style={{ position: 'relative' }}>
        {/* The switcher only matters for someone in more than one label. */}
        <button type="button" className="lc-brand" onClick={() => orgs.length > 1 && setShowSwitcher((s) => !s)} aria-haspopup={orgs.length > 1 ? 'menu' : undefined} aria-expanded={orgs.length > 1 ? showSwitcher : undefined} style={orgs.length > 1 ? undefined : { cursor: 'default' }}>
          <span className="lc-brand-code">{org.shortCode}</span>
          <span style={{ minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2, flex: 1 }}>
            <span className="lc-brand-name lc-ellipsis">{org.name}</span>
            <span className="lc-brand-sub">Label workspace</span>
          </span>
          {orgs.length > 1 && <Icon name="unfold_more" size={18} style={{ color: 'var(--lc-muted)' }} />}
        </button>
        {showSwitcher && <LabelSwitcher orgs={orgs} currentId={org.id} onClose={() => setShowSwitcher(false)} />}
      </div>

      <div className="lc-sidebar-scroll">
        <div className="lc-nav">
          <div className="lc-section-label">Sections</div>
          <nav className="lc-nav-list">
            {nav.map((s) => (
              <Link key={s.id} href={s.tabs[0]?.href ?? '/'} className={cx('lc-nav-item', s.id === activeId && 'is-active')} aria-current={s.id === activeId ? 'page' : undefined}>
                <Icon name={s.icon} />
                <span className="lc-nav-item-text">
                  <span className="lc-nav-item-label">{s.label}</span>
                  <span className="lc-nav-item-sub">{s.sub}</span>
                </span>
              </Link>
            ))}
          </nav>
        </div>

        {widgets.length > 0 && (
          <div className="lc-widgets">
            <div className="lc-widgets-head">
              <span className="lc-section-label">Apps</span>
              <button type="button" className="lc-btn lc-btn--xs" onClick={() => setPickerOpen((o) => !o)}>
                <Icon name={pickerOpen ? 'check' : 'add'} />
                {pickerOpen ? 'Done' : 'Add'}
              </button>
            </div>
            {pickerOpen && (
              <div className="lc-picker">
                {widgets.map((w) => {
                  const on = pinned.includes(w.id);
                  return (
                    <button type="button" key={w.id} className="lc-picker-item" onClick={() => toggle(w.id)}>
                      <Icon name={w.icon} size={18} style={{ color: 'var(--lc-muted)' }} />
                      <span style={{ flex: 1 }}>{w.name}</span>
                      <span className={cx('lc-checkbox-box', on && 'is-on')}>{on && <Icon name="check" />}</span>
                    </button>
                  );
                })}
              </div>
            )}
            {shown.map((w) => (
              <div key={w.id} className="lc-widget">
                <div className="lc-widget-head">
                  <Icon name={w.icon} />
                  <span className="lc-widget-name">{w.name}</span>
                  <button type="button" className="lc-icon-btn" title="Remove from sidebar" onClick={() => toggle(w.id)} style={{ padding: 2, color: 'var(--lc-faint)' }}>
                    <Icon name="close" size={16} />
                  </button>
                </div>
                <div className="lc-widget-body">
                  <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                    <span className="lc-widget-value">{w.value}</span>
                    <span style={{ fontSize: 12, color: 'var(--lc-muted)' }}>{w.unit}</span>
                  </div>
                  <div className="lc-widget-line">{w.line}</div>
                  <Link href={w.href} className="lc-btn lc-btn--link" style={{ marginTop: 6, alignSelf: 'flex-start', fontWeight: 500 }}>
                    {w.cta}
                    <Icon name="arrow_forward" />
                  </Link>
                </div>
              </div>
            ))}
            {shown.length === 0 && (
              <div style={{ border: '1px dashed var(--lc-line-strong)', padding: '14px 12px', fontSize: 12, color: 'var(--lc-muted)', lineHeight: 1.5 }}>No apps pinned. Use Add to pin app widgets here.</div>
            )}
          </div>
        )}
      </div>

      <div className="lc-account-wrap">
        <div className="lc-account">
          <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 3 }}>
            <span className="lc-account-name lc-ellipsis">{user.name}</span>
            <span className="lc-account-role">
              <span className="lc-dot" />
              {user.roleLabel}
            </span>
          </div>
          <Link href="/settings" title="Settings" className="lc-icon-btn">
            <Icon name="settings" size={20} />
          </Link>
          <button
            type="button"
            className="lc-icon-btn"
            title="Sign out"
            onClick={async () => {
              await fetch('/api/auth/logout', { method: 'POST' });
              window.location.href = '/login';
            }}
          >
            <Icon name="logout" size={20} />
          </button>
        </div>
      </div>
    </aside>
  );
}

function LabelSwitcher({ orgs, currentId, onClose }: { orgs: ShellProps['orgs']; currentId: string; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  useOnClickOutside(ref, onClose);
  const switchTo = async (orgId: string) => {
    if (orgId === currentId) return onClose();
    setBusy(true);
    try {
      await api('/api/auth/switch-org', { method: 'POST', body: { orgId } });
      window.location.href = '/';
    } catch (e) {
      toast((e as Error).message, 'error');
      setBusy(false);
    }
  };
  return (
    <div ref={ref} className="lc-popover" role="menu" style={{ left: 12, right: 12, width: 'auto', top: 'calc(100% - 4px)' }}>
      <div className="lc-popover-head">
        <span className="lc-section-label">Switch label</span>
        {busy && <Spinner />}
      </div>
      <div className="lc-popover-body">
        {orgs.map((o) => (
          <button key={o.id} type="button" className="lc-picker-item" style={{ width: '100%' }} onClick={() => switchTo(o.id)} role="menuitem">
            <span className="lc-brand-code" style={{ width: 28, height: 28, fontSize: 10 }}>
              {o.shortCode}
            </span>
            <span style={{ flex: 1 }}>{o.name}</span>
            {o.id === currentId && <Icon name="check" size={18} style={{ color: 'var(--lc-accent)' }} />}
          </button>
        ))}
      </div>
    </div>
  );
}

type Notification = { id: string; kind: string; title: string; body: string | null; href: string | null; readAt: string | null; createdAt: string };

const KIND_ICON: Record<string, string> = { approval: 'approval', mention: 'alternate_email', alert: 'trending_up', reminder: 'event', agent: 'smart_toy', system: 'info', assignment: 'assignment_ind' };

function NotificationsTray({ userId, initialUnread }: { userId: string; initialUnread: number }) {
  const [open, setOpen] = useState(false);
  const [unread, setUnread] = useState(initialUnread);
  const [items, setItems] = useState<Notification[] | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  useOnClickOutside(ref, () => setOpen(false), open);
  useEffect(() => setUnread(initialUnread), [initialUnread]);

  const load = useCallback(async () => {
    try {
      const res = await api<{ items: Notification[]; unread: number }>('/inbox/notifications?limit=12');
      setItems(res.items);
      setUnread(res.unread);
    } catch {
      setItems([]);
    }
  }, []);

  useRealtime('inbox.notification', (e) => {
    if (e.userId && e.userId !== userId) return;
    setUnread((n) => n + 1);
    if (items) setItems((list) => [e.data as unknown as Notification, ...(list ?? [])].slice(0, 12));
  });

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button
        type="button"
        className="lc-bell"
        title="Notifications"
        aria-label={`Notifications${unread ? `, ${unread} unread` : ''}`}
        onClick={() => {
          setOpen((o) => !o);
          if (!open) void load();
        }}
      >
        <Icon name="notifications" />
        {unread > 0 && <span className="lc-bell-count">{unread > 99 ? '99+' : unread}</span>}
      </button>
      {open && (
        <div className="lc-popover">
          <div className="lc-popover-head">
            <span className="lc-card-title" style={{ fontSize: 14 }}>
              Notifications
            </span>
            <button
              type="button"
              className="lc-btn lc-btn--link"
              onClick={async () => {
                await api('/inbox/notifications/read-all', { method: 'POST', body: {} });
                setUnread(0);
                setItems((l) => l?.map((n) => ({ ...n, readAt: n.readAt ?? new Date().toISOString() })) ?? null);
              }}
            >
              Mark all read
            </button>
          </div>
          <div className="lc-popover-body">
            {items === null ? (
              <div style={{ padding: 16 }}>
                <Spinner />
              </div>
            ) : items.length === 0 ? (
              <div style={{ padding: 20, fontSize: 13, color: 'var(--lc-muted)' }}>Nothing new. Approvals, mentions, alerts and reminders appear here.</div>
            ) : (
              items.map((n) => (
                <Link key={n.id} href={n.href ?? '/inbox'} className={cx('lc-popover-item', !n.readAt && 'is-unread')} onClick={() => setOpen(false)}>
                  <Icon name={KIND_ICON[n.kind] ?? 'notifications'} />
                  <span style={{ display: 'flex', flexDirection: 'column', gap: 3, minWidth: 0 }}>
                    <span style={{ fontWeight: n.readAt ? 400 : 600 }}>{n.title}</span>
                    {n.body && <span className="lc-muted lc-ellipsis" style={{ fontSize: 12 }}>{n.body}</span>}
                    <span className="lc-mono lc-muted" style={{ fontSize: 11 }}>
                      {relative(n.createdAt)}
                    </span>
                  </span>
                </Link>
              ))
            )}
          </div>
          <Link href="/inbox" className="lc-btn lc-btn--ghost" style={{ borderTop: '1px solid var(--lc-divider)' }} onClick={() => setOpen(false)}>
            Open inbox
          </Link>
        </div>
      )}
    </div>
  );
}

function AgentIndicator({ initialRunning, pendingApprovals }: { initialRunning: number; pendingApprovals: number }) {
  const [running, setRunning] = useState(initialRunning);
  const [approvals, setApprovals] = useState(pendingApprovals);
  const live = useRef(new Map<string, string>());
  useEffect(() => setRunning(initialRunning), [initialRunning]);
  useEffect(() => setApprovals(pendingApprovals), [pendingApprovals]);
  useRealtime('agents.run.updated', (e) => {
    const { runId, status, delta } = e.data as { runId: string; status: string; delta?: number };
    const wasRunning = live.current.get(runId) === 'running';
    live.current.set(runId, status);
    if (status === 'running' && !wasRunning) setRunning((n) => n + 1);
    else if (status !== 'running' && wasRunning) setRunning((n) => Math.max(0, n - 1));
    else if (delta) setRunning((n) => Math.max(0, n + delta));
  });
  // A new approval request adds one; a decision (or expiry) takes one away.
  useRealtime('agents.approval.requested', () => setApprovals((n) => n + 1));
  useRealtime('agents.approval.updated', (e) => {
    const { pending, status } = e.data as { pending?: number; status?: string };
    if (typeof pending === 'number') setApprovals(pending);
    else if (status && status !== 'pending') setApprovals((n) => Math.max(0, n - 1));
  });
  const warn = approvals > 0;
  return (
    <Link href={warn ? '/inbox/approvals' : '/agents/runs'} className="lc-agent-indicator" title="Agent activity">
      <span className={cx('lc-pulse', running > 0 && 'is-live', warn && 'is-warn')} />
      <Icon name="smart_toy" />
      <span className="lc-hide-mobile">{warn ? `${approvals} approval${approvals === 1 ? '' : 's'}` : running > 0 ? `${running} running` : 'Agents idle'}</span>
    </Link>
  );
}

type SearchResult = { type: string; title: string; sub?: string; href: string; icon?: string };

function CommandPalette({ nav, onClose }: { nav: ShellSection[]; onClose: () => void }) {
  const router = useRouter();
  const [q, setQ] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [index, setIndex] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.focus(), []);

  const navItems: SearchResult[] = useMemo(
    () => nav.flatMap((s) => (s.tabs.length > 1 ? s.tabs.map((t) => ({ type: 'Go to', title: `${s.label} · ${t.label}`, href: t.href, icon: s.icon })) : [{ type: 'Go to', title: s.label, href: s.tabs[0]?.href ?? '/', icon: s.icon }])),
    [nav],
  );
  const filteredNav = q ? navItems.filter((i) => i.title.toLowerCase().includes(q.toLowerCase())) : navItems.slice(0, 8);
  const all = [...filteredNav, ...results];

  const search = useDebouncedCallback(async (term: string) => {
    if (term.trim().length < 2) {
      setResults([]);
      setLoading(false);
      return;
    }
    try {
      const res = await api<{ results: SearchResult[] }>(`/search?q=${encodeURIComponent(term)}`);
      setResults(res.results);
    } catch {
      setResults([]);
    } finally {
      setLoading(false);
    }
  }, 200);

  const go = (r: SearchResult) => {
    onClose();
    router.push(r.href);
  };

  return (
    <>
      <div className="lc-cmdk-backdrop" onClick={onClose} />
      <div className="lc-cmdk" role="dialog" aria-modal="true" aria-label="Command palette">
        <div className="lc-cmdk-input">
          <Icon name="search" style={{ color: 'var(--lc-muted)' }} />
          <input
            ref={input}
            value={q}
            placeholder="Search releases, artists, contacts, documents… or jump to a page"
            onChange={(e) => {
              setQ(e.target.value);
              setIndex(0);
              setLoading(true);
              search(e.target.value);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Escape') onClose();
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                setIndex((i) => Math.min(all.length - 1, i + 1));
              }
              if (e.key === 'ArrowUp') {
                e.preventDefault();
                setIndex((i) => Math.max(0, i - 1));
              }
              if (e.key === 'Enter' && all[index]) go(all[index]);
            }}
          />
          {loading && q.length >= 2 && <Spinner />}
          <span className="lc-kbd">Esc</span>
        </div>
        <div className="lc-cmdk-list">
          {all.length === 0 && <div style={{ padding: '16px', fontSize: 13, color: 'var(--lc-muted)' }}>{loading ? 'Searching…' : 'No matches.'}</div>}
          {all.map((r, i) => (
            <button key={`${r.href}-${i}`} type="button" className={cx('lc-cmdk-item', i === index && 'is-active')} onMouseEnter={() => setIndex(i)} onClick={() => go(r)}>
              <Icon name={r.icon ?? 'arrow_forward'} />
              <span className="lc-ellipsis">{r.title}</span>
              <span className="lc-cmdk-item-sub">{r.sub ?? r.type}</span>
            </button>
          ))}
        </div>
      </div>
    </>
  );
}
