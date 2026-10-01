import { build } from 'esbuild';

// Bundle the worker and the workspace packages it imports (TypeScript source);
// keep third-party packages external so native and dynamic imports resolve at runtime.
await build({
  entryPoints: ['src/index.ts'],
  outfile: 'dist/index.js',
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
