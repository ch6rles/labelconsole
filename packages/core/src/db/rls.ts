/**
 * Tenant isolation, applied after every migration and idempotent.
 *
 * Every base table with an `org_id` column gets RLS enabled and a
 * `tenant_isolation` policy that compares `org_id` with the per-transaction
 * `app.org_id` setting. New module tables are covered automatically, and an
 * integration test fails if any `org_id` table is missing the policy.
 *
 * The restricted app role is not the table owner, so policies apply to it.
 * The owner role (system pool) bypasses them for the few cross-tenant jobs.
 */
export const APP_ROLE = process.env.DB_APP_ROLE ?? 'labelconsole_app';

/** Reference data shared by every label; the app role may read but not write it. */
export const GLOBAL_READONLY_TABLES = ['distributor_aliases'];

/** Tables the app role must never touch (identity internals). */
export const APP_DENIED_TABLES = ['sessions', '__drizzle_migrations'];

const CURRENT_ORG = `nullif(current_setting('app.org_id', true), '')::uuid`;
const CURRENT_USER = `nullif(current_setting('app.user_id', true), '')::uuid`;

export function rlsSql(appRole = APP_ROLE): string {
  return `
DO $rls$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT c.relname AS table_name
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'org_id' AND NOT a.attisdropped
    WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', r.table_name);
    IF r.table_name <> 'memberships' AND NOT EXISTS (
      SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = r.table_name AND policyname = 'tenant_isolation'
    ) THEN
      EXECUTE format(
        'CREATE POLICY tenant_isolation ON %I USING (org_id = ${CURRENT_ORG.replace(/'/g, "''")}) WITH CHECK (org_id = ${CURRENT_ORG.replace(/'/g, "''")})',
        r.table_name
      );
    END IF;
  END LOOP;
END
$rls$;

-- Memberships: visible within the current org, plus a user's own memberships
-- across labels (for the label switcher). Writes only within the current org.
ALTER TABLE memberships ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS membership_read ON memberships;
DROP POLICY IF EXISTS membership_write ON memberships;
CREATE POLICY membership_read ON memberships FOR SELECT USING (org_id = ${CURRENT_ORG} OR user_id = ${CURRENT_USER});
CREATE POLICY membership_write ON memberships FOR ALL USING (org_id = ${CURRENT_ORG}) WITH CHECK (org_id = ${CURRENT_ORG});

-- Organizations: the current org is readable and updatable; other labels the
-- user belongs to are readable (name only matters) for switching.
ALTER TABLE organizations ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_self ON organizations;
DROP POLICY IF EXISTS org_member_read ON organizations;
CREATE POLICY org_self ON organizations FOR ALL USING (id = ${CURRENT_ORG}) WITH CHECK (id = ${CURRENT_ORG});
CREATE POLICY org_member_read ON organizations FOR SELECT USING (id IN (SELECT m.org_id FROM memberships m WHERE m.user_id = ${CURRENT_USER}));

-- Users: only yourself and people in the current org.
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS user_visibility ON users;
CREATE POLICY user_visibility ON users FOR SELECT USING (
  id = ${CURRENT_USER} OR id IN (SELECT m.user_id FROM memberships m WHERE m.org_id = ${CURRENT_ORG})
);
DROP POLICY IF EXISTS user_self_update ON users;
CREATE POLICY user_self_update ON users FOR UPDATE USING (id = ${CURRENT_USER}) WITH CHECK (id = ${CURRENT_USER});

-- Grants for the restricted role.
GRANT USAGE ON SCHEMA public TO ${appRole};
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${appRole};
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${appRole};
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO ${appRole};
REVOKE INSERT, DELETE ON users FROM ${appRole};
${GLOBAL_READONLY_TABLES.map((t) => `DO $g$ BEGIN IF to_regclass('public.${t}') IS NOT NULL THEN REVOKE INSERT, UPDATE, DELETE ON ${t} FROM ${appRole}; END IF; END $g$;`).join('\n')}
${APP_DENIED_TABLES.map((t) => `DO $d$ BEGIN IF to_regclass('public."${t}"') IS NOT NULL THEN REVOKE ALL ON "${t}" FROM ${appRole}; END IF; END $d$;`).join('\n')}
DO $d$ BEGIN IF to_regclass('drizzle.__drizzle_migrations') IS NOT NULL THEN REVOKE ALL ON SCHEMA drizzle FROM ${appRole}; END IF; END $d$;
`;
}
