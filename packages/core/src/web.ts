import type { ReactNode } from 'react';
import type { SessionInfo } from './auth';
import type { ServiceContext } from './context';
import type { ModuleManifest } from './modules';

/**
 * The web half of a module: pages (rendered inside the console shell by the
 * catch-all route) and panels it contributes to other modules' detail pages,
 * so an artist page can show contracts, releases and files without People
 * importing Documents, Catalogue or Drive.
 */
export type Run = <T>(fn: (ctx: ServiceContext) => Promise<T>) => Promise<T>;

export type PageProps = {
  params: Record<string, string>;
  searchParams: Record<string, string | undefined>;
  session: SessionInfo;
  /** Run tenant-scoped service calls as the signed-in user (one transaction per call). */
  run: Run;
  /** Panels other modules contribute for an entity type, filtered by permission and enablement. */
  panels: (entityType: string) => PanelDef[];
  enabled: Set<string>;
  path: string;
};

export type PageDef = {
  /** Route pattern under the console root, e.g. `catalog/releases/:id`. */
  path: string;
  permission?: string;
  /** Used only when no enabled module registers the same path (e.g. a "not on your plan" placeholder). */
  fallback?: boolean;
  component: (props: PageProps) => Promise<ReactNode> | ReactNode;
};

export type PanelProps = { entityId: string; run: Run; session: SessionInfo };

export type PanelDef = {
  id: string;
  entityType: string;
  title: string;
  order?: number;
  permission?: string;
  component: (props: PanelProps) => Promise<ReactNode> | ReactNode;
};

export interface ModuleWeb {
  manifest: ModuleManifest;
  pages: PageDef[];
  panels?: PanelDef[];
}

export function defineWeb(m: ModuleWeb): ModuleWeb {
  return m;
}
