/**
 * One permission model for humans and agents.
 *
 * Permissions are `module:action` strings declared in module manifests.
 * Roles grant patterns (`catalogue:*`, `*:read`, `*`), which are expanded
 * against the registry of declared permissions into a concrete set. Concrete
 * sets make intersection (agent capped by its owner, child capped by parent)
 * exact and easy to test.
 */

export type PermissionDef = { key: string; description: string; sensitive?: boolean };

const g = globalThis as unknown as { __lcPermissionRegistry?: Map<string, PermissionDef> };
const registry: Map<string, PermissionDef> = (g.__lcPermissionRegistry ??= new Map());

export function registerPermissions(defs: PermissionDef[]) {
  for (const d of defs) {
    if (!/^[a-z_]+:[a-z_]+$/.test(d.key)) throw new Error(`Invalid permission key "${d.key}" (expected module:action)`);
    registry.set(d.key, d);
  }
}

export function allPermissions(): PermissionDef[] {
  return [...registry.values()];
}

export const BUILT_IN_ROLES = ['owner', 'admin', 'manager', 'ar', 'marketing', 'finance', 'viewer'] as const;
export type BuiltInRole = (typeof BUILT_IN_ROLES)[number];

export const ROLE_LABELS: Record<BuiltInRole, string> = {
  owner: 'Owner',
  admin: 'Admin',
  manager: 'Manager',
  ar: 'A&R',
  marketing: 'Marketing',
  finance: 'Finance',
  viewer: 'Viewer',
};

/** Sensitive permissions are never granted by `*:read` style patterns, only by name or `*`. */
const ROLE_GRANTS: Record<BuiltInRole, string[]> = {
  owner: ['*'],
  admin: ['*'],
  manager: [
    'catalogue:*', 'people:*', 'network:*', 'marketing:*', 'marketing:spend', 'drive:*', 'streams:*', 'inbox:*',
    'documents:read', 'documents:write', 'documents:read_financial',
    'agents:read', 'agents:run', 'agents:manage', 'agents:approve',
    'settings:read', 'settings:audit',
  ],
  ar: [
    'catalogue:*', 'people:read', 'people:write', 'network:read', 'marketing:read', 'drive:read', 'drive:write',
    'documents:read', 'streams:read', 'inbox:*', 'agents:read', 'agents:run', 'agents:approve', 'settings:read',
  ],
  marketing: [
    'marketing:*', 'marketing:spend', 'network:*', 'catalogue:read', 'people:read', 'streams:read', 'drive:read', 'drive:write',
    'documents:read', 'inbox:*', 'agents:read', 'agents:run', 'agents:approve', 'settings:read',
  ],
  finance: [
    'documents:*', 'documents:read_financial', 'documents:read_confidential', 'catalogue:read', 'catalogue:write', 'people:read', 'streams:read', 'marketing:read', 'network:read',
    'drive:read', 'drive:write', 'inbox:*', 'agents:read', 'settings:read', 'settings:audit',
  ],
  viewer: ['*:read', 'inbox:*'],
};

export function roleGrants(role: string): string[] {
  return (ROLE_GRANTS as Record<string, string[]>)[role] ?? [];
}

function matches(pattern: string, def: PermissionDef): boolean {
  if (pattern === '*') return true;
  if (pattern === def.key) return true;
  const [pm, pa] = pattern.split(':');
  const [dm, da] = def.key.split(':');
  if (def.sensitive) return false; // sensitive keys need an exact grant
  return (pm === '*' || pm === dm) && (pa === '*' || pa === da);
}

export function expand(patterns: string[]): Set<string> {
  const out = new Set<string>();
  for (const def of registry.values()) {
    if (patterns.some((p) => matches(p, def))) out.add(def.key);
  }
  return out;
}

export class PermissionSet {
  readonly keys: ReadonlySet<string>;

  constructor(keys: Iterable<string>) {
    this.keys = new Set(keys);
  }

  static fromPatterns(patterns: string[]) {
    return new PermissionSet(expand(patterns));
  }

  static forRole(role: string, extra: string[] = [], customRolePermissions?: string[]) {
    const base = role === 'custom' ? customRolePermissions ?? [] : roleGrants(role);
    return PermissionSet.fromPatterns([...base, ...extra]);
  }

  has(key: string): boolean {
    return this.keys.has(key);
  }

  intersect(other: PermissionSet): PermissionSet {
    return new PermissionSet([...this.keys].filter((k) => other.has(k)));
  }

  toArray(): string[] {
    return [...this.keys].sort();
  }
}

/** For the roles matrix in Admin: Full / Edit / View / none for a module. */
export function accessLevel(set: PermissionSet, moduleId: string): 'Full' | 'Edit' | 'View' | '—' {
  const keys = [...registry.keys()].filter((k) => k.startsWith(moduleId + ':'));
  if (keys.length === 0) return '—';
  if (keys.every((k) => set.has(k))) return 'Full';
  if (set.has(`${moduleId}:write`)) return 'Edit';
  if (set.has(`${moduleId}:read`)) return 'View';
  return '—';
}
