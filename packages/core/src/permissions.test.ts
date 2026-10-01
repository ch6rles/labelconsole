import { beforeAll, describe, expect, it } from 'vitest';
import { PermissionSet, accessLevel, registerPermissions } from './permissions';

beforeAll(() => {
  registerPermissions([
    { key: 'catalogue:read', description: '' },
    { key: 'catalogue:write', description: '' },
    { key: 'catalogue:delete', description: '' },
    { key: 'documents:read', description: '' },
    { key: 'documents:read_financial', description: '', sensitive: true },
    { key: 'settings:credentials', description: '', sensitive: true },
    { key: 'inbox:read', description: '' },
  ]);
});

describe('PermissionSet', () => {
  it('owner gets everything including sensitive keys', () => {
    const p = PermissionSet.forRole('owner');
    expect(p.has('settings:credentials')).toBe(true);
    expect(p.has('documents:read_financial')).toBe(true);
  });

  it('wildcard patterns never grant sensitive keys', () => {
    const viewer = PermissionSet.forRole('viewer');
    expect(viewer.has('catalogue:read')).toBe(true);
    expect(viewer.has('catalogue:write')).toBe(false);
    expect(viewer.has('documents:read_financial')).toBe(false);
    expect(PermissionSet.fromPatterns(['documents:*']).has('documents:read_financial')).toBe(false);
  });

  it('exact grants include sensitive keys', () => {
    expect(PermissionSet.fromPatterns(['documents:read_financial']).has('documents:read_financial')).toBe(true);
  });

  it('intersects (agents are capped by their owner)', () => {
    const agentRole = PermissionSet.fromPatterns(['catalogue:*']);
    const owner = PermissionSet.forRole('viewer');
    const effective = agentRole.intersect(owner);
    expect(effective.toArray()).toEqual(['catalogue:read']);
  });

  it('custom roles and extra grants', () => {
    const p = PermissionSet.forRole('custom', ['inbox:read'], ['catalogue:read']);
    expect(p.toArray()).toEqual(['catalogue:read', 'inbox:read']);
  });

  it('reports matrix access levels', () => {
    expect(accessLevel(PermissionSet.forRole('owner'), 'catalogue')).toBe('Full');
    expect(accessLevel(PermissionSet.fromPatterns(['catalogue:read', 'catalogue:write']), 'catalogue')).toBe('Edit');
    expect(accessLevel(PermissionSet.forRole('viewer'), 'catalogue')).toBe('View');
    expect(accessLevel(PermissionSet.fromPatterns([]), 'catalogue')).toBe('—');
  });

  it('rejects malformed keys', () => {
    expect(() => registerPermissions([{ key: 'Bad Key', description: '' }])).toThrow();
  });
});
