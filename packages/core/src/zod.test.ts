import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { patchOf } from './zod';

describe('patchOf', () => {
  const Input = z.object({ title: z.string().min(1), status: z.enum(['draft', 'live']).default('draft'), tags: z.array(z.string()).default([]), note: z.string().nullable().optional() });

  it('makes every field optional without applying defaults', () => {
    expect(patchOf(Input).parse({ title: 'New name' })).toEqual({ title: 'New name' });
    expect(patchOf(Input).parse({})).toEqual({});
    // Zod's own partial() would have reset these:
    expect(Input.partial().parse({ title: 'x' })).toEqual({ title: 'x', status: 'draft', tags: [] });
  });

  it('still validates the fields that are present', () => {
    expect(() => patchOf(Input).parse({ status: 'archived' })).toThrow();
    expect(() => patchOf(Input).parse({ title: '' })).toThrow();
    expect(patchOf(Input).parse({ note: null })).toEqual({ note: null });
  });
});
