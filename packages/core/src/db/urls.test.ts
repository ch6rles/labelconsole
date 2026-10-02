import { describe, expect, it } from 'vitest';
import { applyDerivedDatabaseUrls } from './urls';

const railway = 'postgresql://postgres:supersecret@postgres.railway.internal:5432/railway';

describe('derived database URLs', () => {
  it('derives the app and owner role URLs from one admin URL', () => {
    const e: NodeJS.ProcessEnv = { DATABASE_SUPERUSER_URL: railway, SIGNING_SECRET: 'x'.repeat(40) };
    expect(applyDerivedDatabaseUrls(e)).toBe(true);
    const app = new URL(e.DATABASE_URL!);
    const sys = new URL(e.DATABASE_SYSTEM_URL!);
    expect([app.protocol, app.hostname, app.port, app.pathname, app.username]).toEqual(['postgresql:', 'postgres.railway.internal', '5432', '/labelconsole', 'labelconsole_app']);
    expect([sys.username, sys.pathname]).toEqual(['labelconsole_owner', '/labelconsole']);
    // Passwords come from SIGNING_SECRET: long, different per role, never the admin password, stable across restarts.
    expect(app.password).toMatch(/^[0-9a-f]{64}$/);
    expect(app.password).not.toBe(sys.password);
    expect(e.DATABASE_URL).not.toContain('supersecret');
    const again: NodeJS.ProcessEnv = { DATABASE_SUPERUSER_URL: railway, SIGNING_SECRET: 'x'.repeat(40) };
    applyDerivedDatabaseUrls(again);
    expect(again.DATABASE_URL).toBe(e.DATABASE_URL);
  });

  it('never overrides given URLs, and needs SIGNING_SECRET to derive', () => {
    const given: NodeJS.ProcessEnv = { DATABASE_URL: 'postgres://a@h/db', DATABASE_SYSTEM_URL: 'postgres://b@h/db', DATABASE_SUPERUSER_URL: railway, SIGNING_SECRET: 'x'.repeat(40) };
    expect(applyDerivedDatabaseUrls(given)).toBe(false);
    expect(given.DATABASE_URL).toBe('postgres://a@h/db');
    const noSecret: NodeJS.ProcessEnv = { DATABASE_SUPERUSER_URL: railway };
    expect(applyDerivedDatabaseUrls(noSecret)).toBe(false);
    expect(noSecret.DATABASE_URL).toBeUndefined();
  });
});
