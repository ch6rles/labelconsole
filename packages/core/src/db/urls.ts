import { createHmac } from 'node:crypto';

/**
 * Database connection strings. Normally DATABASE_URL (the restricted app role,
 * where row-level security applies) and DATABASE_SYSTEM_URL (the owner role)
 * are given. Hosts like Railway hand out a single admin connection string
 * instead: then set only DATABASE_SUPERUSER_URL, and the two role URLs are
 * derived from it (same server, database `labelconsole`). Their passwords come
 * from SIGNING_SECRET, so nothing else needs storing, and `setup` creates the
 * roles and the database with exactly these values (and updates the passwords
 * if SIGNING_SECRET ever changes).
 */
export const DERIVED_DATABASE = { name: 'labelconsole', ownerRole: 'labelconsole_owner', appRole: 'labelconsole_app' } as const;

function derive(superuserUrl: string, role: string, secret: string) {
  const u = new URL(superuserUrl);
  u.username = role;
  u.password = createHmac('sha256', secret).update(`labelconsole:db:${role}`).digest('hex');
  u.pathname = `/${DERIVED_DATABASE.name}`;
  return u.toString();
}

/** Fill in DATABASE_URL and DATABASE_SYSTEM_URL from DATABASE_SUPERUSER_URL when they aren't set. Never overrides given values. */
export function applyDerivedDatabaseUrls(e: NodeJS.ProcessEnv = process.env) {
  if ((e.DATABASE_URL && e.DATABASE_SYSTEM_URL) || !e.DATABASE_SUPERUSER_URL || !e.SIGNING_SECRET) return false;
  e.DATABASE_URL ||= derive(e.DATABASE_SUPERUSER_URL, DERIVED_DATABASE.appRole, e.SIGNING_SECRET);
  e.DATABASE_SYSTEM_URL ||= derive(e.DATABASE_SUPERUSER_URL, DERIVED_DATABASE.ownerRole, e.SIGNING_SECRET);
  return true;
}
