import type { ReactNode } from 'react';
import { listUserOrgs } from '@labelconsole/core/auth';
import { logger } from '@labelconsole/core/logger';
import { buildNav, modules, type ShellCounts } from '@labelconsole/core/modules';
import { ROLE_LABELS, type BuiltInRole } from '@labelconsole/core/permissions';
import { ConsoleShell, type ShellWidget } from '@labelconsole/ui/shell';
import { shortCodeFor } from '@labelconsole/core/auth';
import { getEnabledModules, requireSession, runAs } from '@/server/session';

export const dynamic = 'force-dynamic';

const DASHBOARD_SECTION = { id: 'dashboard', label: 'Dashboard', icon: 'grid_view', sub: 'Overview, recent activity', order: 0, tabs: [{ id: 'dashboard', label: 'Dashboard', href: '/' }] };

export default async function ConsoleLayout({ children }: { children: ReactNode }) {
  const session = await requireSession();
  const enabled = await getEnabledModules(session);
  const can = (p: string) => session.permissions.has(p);
  const nav = [DASHBOARD_SECTION, ...buildNav(enabled, can)];
  const run = runAs(session);
  const active = modules().filter((m) => enabled.has(m.manifest.id));

  const [widgets, counts, orgs] = await Promise.all([
    run(async (ctx) => {
      const out: ShellWidget[] = [];
      for (const m of active) {
        for (const w of m.widgets ?? []) {
          if (w.permission && !can(w.permission)) continue;
          try {
            out.push({ id: w.id, name: w.name, icon: w.icon, desc: w.desc, ...(await w.load(ctx)) });
          } catch (err) {
            logger.warn({ err, widget: w.id }, 'widget failed to load');
          }
        }
      }
      return out;
    }),
    run(async (ctx) => {
      const c: ShellCounts = { unread: 0, runningAgents: 0, pendingApprovals: 0 };
      for (const m of active) if (m.shell) Object.assign(c, await m.shell(ctx, session.user.id).catch(() => ({})));
      return c;
    }),
    listUserOrgs(session.user.id),
  ]);

  const settings = session.org.settings as { shortCode?: string; siteUrl?: string };
  return (
    <ConsoleShell
      nav={nav}
      org={{ id: session.org.id, name: session.org.name, shortCode: settings.shortCode || shortCodeFor(session.org.name), siteUrl: settings.siteUrl ?? null }}
      orgs={orgs.map((o) => ({ id: o.id, name: o.name, shortCode: (o.settings as { shortCode?: string }).shortCode || shortCodeFor(o.name) }))}
      user={{ id: session.user.id, name: session.user.name, roleLabel: ROLE_LABELS[session.membership.role as BuiltInRole] ?? session.membership.role }}
      widgets={widgets}
      unread={counts.unread}
      runningAgents={counts.runningAgents}
      pendingApprovals={counts.pendingApprovals}
    >
      {children}
    </ConsoleShell>
  );
}
