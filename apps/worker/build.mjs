import { build } from 'esbuild';

// Bundle the worker and the workspace packages it imports (TypeScript source);
// keep third-party packages external so native and dynamic imports resolve at runtime.
await build({
  // index: the worker service; migrate: the release step before new code starts; setup: one-time DB bootstrap;
  // owner: add an owner or reset a password from the terminal.
  entryPoints: ['src/index.ts', 'src/migrate.ts', 'src/setup.ts', 'src/owner.ts'],
  outdir: 'dist',
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  sourcemap: true,
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
  plugins: [
    {
      name: 'externalize-deps',
      setup(b) {
        b.onResolve({ filter: /^[^./]/ }, (args) => (args.path.startsWith('@labelconsole/') ? undefined : { path: args.path, external: true }));
      },
    },
  ],
  logLevel: 'info',
});
