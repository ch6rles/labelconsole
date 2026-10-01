import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import type { PageDef } from '@labelconsole/core/web';
import { EmptyState, Page } from '@labelconsole/ui';
import { webModules } from '@/server/modules';
import { getEnabledModules, requireSession, runAs } from '@/server/session';

type Match = { moduleId: string; page: PageDef; params: Record<string, string> };

function matchPage(path: string): Match | null {
  const segs = path.split('/').filter(Boolean);
  let best: (Match & { score: number }) | null = null;
  for (const m of webModules) {
    for (const page of m.pages) {
      const pat = page.path.split('/').filter(Boolean);
      if (pat.length !== segs.length) continue;
      const params: Record<string, string> = {};
      let score = 0;
      let ok = true;
      for (let i = 0; i < pat.length; i++) {
        if (pat[i].startsWith(':')) params[pat[i].slice(1)] = decodeURIComponent(segs[i]);
        else if (pat[i] === segs[i]) score += 2;
        else {
          ok = false;
          break;
        }
      }
      if (ok && (!best || score > best.score)) best = { moduleId: m.manifest.id, page, params, score };
    }
  }
  return best;
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string[] }> }): Promise<Metadata> {
  const { slug } = await params;
  const href = '/' + slug.join('/');
  for (const m of webModules)
    for (const c of m.manifest.nav)
      for (const t of c.tabs) if (href === t.href || href.startsWith(t.href + '/')) return { title: c.section.label === t.label ? t.label : `${t.label} · ${c.section.label}` };
  return {};
}

export default async function ModulePage({ params, searchParams }: { params: Promise<{ slug: string[] }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const [{ slug }, sp] = await Promise.all([params, searchParams]);
  const session = await requireSession();
  const enabled = await getEnabledModules(session);
  const path = slug.join('/');
  const match = matchPage(path);
  if (!match || !enabled.has(match.moduleId)) notFound();
  if (match.page.permission && !session.permissions.has(match.page.permission)) {
    return (
      <Page>
        <EmptyState icon="lock" title="You don't have access to this page">
          Your role does not include the {match.page.permission} permission. Ask an admin of {session.org.name} if you need it.
        </EmptyState>
      </Page>
    );
  }
  const searchParamsFlat = Object.fromEntries(Object.entries(sp).map(([k, v]) => [k, Array.isArray(v) ? v[0] : v]));
  const panels = (entityType: string) =>
    webModules
      .filter((m) => enabled.has(m.manifest.id))
      .flatMap((m) => m.panels ?? [])
      .filter((p) => p.entityType === entityType && (!p.permission || session.permissions.has(p.permission)))
      .sort((a, b) => (a.order ?? 50) - (b.order ?? 50));
  return match.page.component({ params: match.params, searchParams: searchParamsFlat, session, run: runAs(session), panels, enabled, path: `/${path}` });
}
