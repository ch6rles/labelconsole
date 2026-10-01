import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/** Every permission string the code checks must be declared by some module (or core); a typo silently hides a feature. */
const ROOT = path.resolve(__dirname, '..');
function files(dir: string, out: string[] = []) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.') || name === 'dist') continue;
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) files(p, out);
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

describe('permission keys', () => {
  it('are all declared', () => {
    const sources = ['modules', 'packages', 'apps/web/src', 'apps/worker/src'].flatMap((d) => files(path.join(ROOT, d)));
    const declared = new Set<string>();
    const used = new Map<string, string>();
    for (const f of sources) {
      const text = readFileSync(f, 'utf8');
      for (const m of text.matchAll(/key: '([a-z_]+:[a-z_]+)'/g)) declared.add(m[1]);
      for (const m of text.matchAll(/(?:permissions\.has|\.can|\.assert|assertPermission)\('([a-z_]+:[a-z_]+)'\)|permission: '([a-z_]+:[a-z_]+)'/g)) used.set(m[1] ?? m[2], path.relative(ROOT, f));
    }
    const missing = [...used].filter(([p]) => !declared.has(p)).map(([p, f]) => `${p} (${f})`);
    expect(missing).toEqual([]);
    expect(declared.size).toBeGreaterThan(20);
  });
});
