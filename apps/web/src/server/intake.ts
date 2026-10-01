import 'server-only';
import { sql } from 'drizzle-orm';
import { systemDb } from '@labelconsole/core/db/client';
import { organizations } from '@labelconsole/core/db/schema';

/** Resolve a public intake token to its label (cross-tenant lookup by secret, so the system pool). */
export async function orgForIntakeToken(token: string) {
  if (!/^[A-Za-z0-9_-]{10,40}$/.test(token)) return null;
  const [org] = await systemDb().select({ id: organizations.id, name: organizations.name }).from(organizations).where(sql`${organizations.settings}->>'intakeToken' = ${token}`);
  return org ?? null;
}
